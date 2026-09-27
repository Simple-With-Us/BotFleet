# Delta Audit Reconciliation And P0/P1 Fix Wave — Wed, Sep 2, 2026

> **2026-09-22 [MM] archaeology note:** historical references to `com.jay.botfleet-server` and `com.botfleet.app` kept verbatim as the bundle IDs that were live at audit time.  Both were renamed on 2026-09-22 (PR forthcoming): macOS app `app.botfleet.macos`, server LaunchAgent `app.botfleet.server`, iOS app `app.botfleet.ios`, iOS widgets `app.botfleet.ios.widgets`, Electron Recorder `app.botfleet.recorder.macos`, Electron Speech helper `app.botfleet.speech.macos`, plus the new app group `group.app.botfleet` and associated domain `botfleet.app`.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

**Seat:** CLAUDE.  **Branch:** `claude/fleet-docs`.  **Worktree:** `~/apps/botfleet-claude`.  **Board:** `781554fd` (analysis), `ef0c48c6` (main repair), wave rows `92cbbb32` `bb105568` `c5ffa6db` `292b248b` `05e95a05` `3307a1db`.  **Owner input:** `BotFleet-Delta-Audit-2026-09-01.docx` (Grok seat, HEAD `b34ac90`).

**Method:** 16 specialist reviewers over `b34ac90` (238 raw findings), adversarial verification (144 confirmed, 89 left unverified when the session capped, 4 refuted), Grok's pickup report (`2026-09-01-botfleet-analysis-v2.md`), then a hands-on repair of `main` on Sep 2 and an owner-authorized fixer wave.  Section numbers continue the docx so the two documents can be read together.

## 17.  Independent Audit Reconciliation

This section was added after an independent 16-reviewer audit of `b34ac90` (the same HEAD this report reviewed), adversarial verification of its 238 findings, the Grok pickup report landed as `docs/audits/2026-09-01-botfleet-analysis-v2.md`, and a hands-on repair of `main` on Sep 2.  Every claim in the compact register (Table 12) and the delta tables (Tables 3, 4, 11) was re-checked.  Status is given against two points in time: the docx baseline `b34ac90`, and `main` as repaired on Sep 2 (`claude/fix-main-red`, PR #130).

Verdict key: **Concur** (true as written), **Partial** (true in part; correction given), **Dispute** (false or materially misleading; evidence given), **Cannot verify** (needs a device or an account this pass did not have).

### 17.1  Verdicts On The Compact Register

| ID | Delta Audit says | Verdict | Evidence and correction |
|---|---|---|---|
| P0-1 | Fallbacks PARTIAL: error chips ignored, tool activity and rooms still block | **Concur at b34ac90; overtaken** | PR #95 replaced the gate with `turnProducedAssistantOutput` + `selectTurnFallback`, covered rooms, persisted the fallback selection, and posted a "Fell over to" chip.  PR #119/#123 added quota-chip failover.  The overnight conflict merge then kept PR #90's older gate as well, shadowing #95's result; PR #130 removes the shadow and folds #90's auto-failover into the tested gate.  Retry-chip coverage (`turn.retrying` with `ok: true`) is still the open remainder, board `e556f063`. |
| W1, W2 | Composer paste fixed | Concur | Still fixed on main. |
| W3 | PARTIAL: JS Studio, CSS Midnight, iOS system | Concur → now closed | iOS light pinned in #92; Studio `@theme` defaults claimed by #95 (re-verification in flight, batch B5/B8). |
| W4 | CSS `@theme` Midnight FOUC | Partial | #95 claims Studio defaults.  Not yet re-verified after the merges. |
| W5 | drafts.ts listener via `useState` | Concur → claimed fixed in #95 | Re-verification in flight. |
| W6-W8, W10 | Client state races | Concur → claimed fixed in #95 | Re-verification in flight. |
| W9 | deleteBot ghost memberIds | Concur → claimed fixed in #95 | Re-verification in flight. |
| W11, W12 | Electron window-open / open-file | Concur at b34ac90; **fixed** | PR #91 landed `windowOpenExternalUrl` (http/https only) and `resolveOpenablePath` confinement with a node test. |
| W13 | Static handler `..` strip, loopback only | Concur | Still open; batch B5 adds `realpath` containment. |
| W14 | Control-client fail-open | Concur → claimed fixed in #95 | Re-verification in flight (B5). |
| W15 | Auto-approve misses pipe-to-shell | Concur → claimed fixed in #95 | Re-verification in flight (B5). |
| W16 | VM stall does not release lease | Concur → claimed fixed in #95 | Re-verification in flight. |
| W17 | No computer-dispatch recovery cards | Concur → fixed in #95 | ErrorRow now carries Retry / Open Computer / Use This Computer / Create Local VM; the merge damage in that file is repaired in #130. |
| I1 | iOS modelSelection encodes | Concur | Still fixed. |
| I2 | iOS image attachment path shape | Partial | Grok's re-read: the iOS composer has no image attach at all; avatars correctly use `/api/attachments`.  PR #113 added chat files.  Treat the original finding as obsolete rather than open. |
| I3 | Group avatarCrop dropped on PATCH | Concur → claimed fixed in #95 and #98 | Re-verification in flight. |
| I4 | Closed-app push, `pushType nil` | Concur at b34ac90 | PR #113 added APNs wake.  Whether a killed app now receives alerts needs a device pass.  **Cannot verify** end to end. |
| I5 | Soft Return PARTIAL | Cannot verify | No device pass in this session either. |
| I6 | iPhone-only, site says iPad | Concur at b34ac90; overtaken | PR #113 restored iPad; site copy is being re-stated by batch B3a. |
| I7 | No iOS light default | Concur; **fixed** in #92 | `preferredColorScheme(.light)` on `CompanionApp`. |
| I8 | Entitlements vs project.yml WATCH | Concur | XcodeGen still regenerates entitlements from `project.yml`; the two now match at HEAD. |
| NEW-ATS | `NSAllowsArbitraryLoads` true | Concur; **fixed** in #92 | `NSAllowsLocalNetworking` plus a `ts.net` exception only.  The docx's claim that #81 duplicated `CFBundleURLSchemes` and `NSBonjourServices` is **Disputed**: at `b34ac90` each appears once in `project.yml` and once in the generated `Info.plist`. |
| C1 | Composio `REGISTRATION_MODE=open` | Concur → claimed fixed in #95 | Code closes registration; the deployed Worker is a different matter (see P0-BRK below). |
| C2 | Broker Session in isolate memory | Concur → claimed fixed in #95 | D1 session persistence in code; not deployed. |
| C6 | README paths fixed, tag 0.1.37, circular fork copy | Partial | Fork copy fixed in #95.  At `b34ac90` every README download link pointed at `jaywedgeworth22/botfleet-releases`, which did not exist; the repository was created on Sep 2 and the links resolve now (see C7). |
| C7 | Site Download CTA hits source-repo Releases, artifacts do not live there | **Partial** | At `b34ac90` the only release anywhere was `jaywedgeworth22/BotFleet` v0.1.38, and `jaywedgeworth22/botfleet-releases` did not exist, so the site CTA was the one working download and the README links were dead.  On Sep 2 (03:20 UTC) `jaywedgeworth22/botfleet-releases` was created with v0.1.38 (`BotFleet.dmg`, `BotFleet-intel.dmg`, and the two versioned DMGs), so README and site links now resolve.  Still open: no `latest-mac.yml` or zip on that release, and `electron-builder.yml` publish still targets `milind-soni/botfleet-releases`, so in-app "Check for updates" cannot succeed.  Batch B3b retargets publish to `jaywedgeworth22/botfleet-releases`. |
| C8 | `--ink-muted` undefined | Concur → fixed in #95 | Verify in B3a. |
| D2 | ACP `--mcp` argv spaces | Concur → claimed fixed in #95 | Re-verification in flight. |
| D3 | DeepSeek prices 10x apart | Concur → claimed fixed in #95 | UI table now generated from billing per the PR body. |
| D4 | dsh offers retired ids | Concur; **fixed** | `STATIC_DSH_MODELS` carries V4 ids only; the merge duplicated the catalog, #130 dedupes it. |
| TEL | Telemetry badge error-path only | Concur → claimed fixed in #95 | Four states per the PR body. |
| SEC | SECURITY.md plaintext keys, upstream mailbox | Concur → claimed fixed in #95 | |
| HAND | telemetry.ts reads `~/.secrets/global-api-keys` | Concur → claimed fixed in #95 | Verify in B5. |
| LOG | Effort-log In Progress after merge | Concur | Live board corrected on Sep 1; the repo mirror was reconciled by #97.  Both drifted again within a day; the mirror discipline needs a landing-time check. |

### 17.2  Verdicts On Tables 3, 4, And 11

| Claim | Verdict | Evidence and correction |
|---|---|---|
| Table 3: "Webhook X-BotFleet-Event rejected" fixed by #78 | Concur | |
| Table 3: "Resource-threshold triggers new" | Concur, with a correction | The feature landed, but `com.jay.botfleet-server` could not run it: the LaunchAgent's checkout (`~/apps/botfleet-grok` on `producer/fix-main-ci`) uses a TypeScript parameter property that Node's strip-types loader rejects, and the job crash-looped more than 15,000 times by Sep 2.  Port 8799 was served only by the GUI app.  Batch B1 moves the agent to a main-tracking checkout. |
| Table 3: "No BotFleet Sentry project" fixed | Concur | Sentry org `jays-services` has project `botfleet`; zero unresolved issues in 30 days. |
| Table 4: PR #31 title over-claims (W11/W12 live) | Concur at b34ac90; closed by #91 | |
| Table 4: PRs #46/#47 DeepSeek removal was a rename | Concur | DeepSeek API driver and ACP driver remain; the ACP driver is a sed copy of the Kimi driver (independent finding `drivers:acp-deepseek-driver-is-kimi-sed-copy`). |
| Table 4: Light-first partial | Concur | See W3/W4. |
| Table 4: Telemetry honesty partial | Concur | See TEL. |
| Table 11: "Fallbacks degrade automatically" only on 1:1 without activity | Concur at b34ac90 | See P0-1. |
| Table 11: "iPhone and iPad companion" false | Concur at b34ac90; overtaken by #113 | |
| Table 11: "Download for Mac" points at the wrong repo | Partial | See C7: true at `b34ac90` in the opposite direction (the site link worked, the README did not); resolved by the Sep 2 creation of `botfleet-releases`.  Auto-update is the remaining gap. |
| Table 11: "Always-on iMessage relay" status disagreement | Concur | `com.jay.botfleet-imessage-relay` is not loaded in launchd on this Mac (`launchctl list` shows `com.jay.imessage-accountant-forward` and `com.jay.mac-resource-watch` only); MAC-LOCAL-PROCESSES.md still says Up.  Board `80dd2680`. |
| Table 11: "Active Telemetry" hardcoded | Concur → claimed fixed in #95 | |
| Table 11: README relationship circular | Concur → fixed in #95 | |
| Section 2, "Board returned 401 from this seat" | Concur | The Mac's `gh` credential is also invalid (env token and keyring), which the docx did not note; it blocks `sync-status.mjs`, land-lane, and any bot that shells out to `gh`. |
| Section 15, "Branch prefix from fleet-apps.json" | **Cannot verify** | No `fleet-apps.json` exists under `/Users/jay/apps` or `ai-fleet-coordinator`; seat prefixes are defined in `AGENT-SYNC.md`. |

### 17.3  Claims The Delta Audit Missed (New On Sep 1-2)

These were not in the docx because they are live-ops facts or appeared after `b34ac90`.

- **Main went red overnight.**  The `Merge PR N: resolve conflicts by keeping both sides` commits (#83, #86, #90, #96, #99, #100, #102, #120) left `main` unable to typecheck, unable to boot (`registry.load` hung on Cursor model discovery), and unable to run its own suite.  Repaired in PR #130.
- **The bot profile PATCH never persisted `computers`.**  Since PR #117 the web and iOS clients send a `computers` array; the server validated the legacy singular `computer`, stored it as a stray field the runtime ignores, and dropped the array.  Fixed in #130.
- **Creating a bot cost ~5 seconds.**  Every `POST /api/bots` and `GET /api/instances` re-probed every engine CLI (`--version`, auth, model discovery) with no memo.  `registry.describe({ maxAgeMs })` in #130.
- **Always-on harness crash loop** and the stale `update-botfleet.sh` source (batch B1).
- **botfleet.app regressed at 11:47 CDT on Sep 1.**  Vercel builds `apps/site` from the monorepo on every push; its `features.json` still carried the `XYZ123` TestFlight placeholder and `state: "open"` provenance, and PR #82's merge deployed it.  The separate `botfleet-site` repo deploys to the same project, so the two fight.  Batch B3a.
- **Universal links cannot work.**  `https://botfleet.app/.well-known/apple-app-site-association` is 404 while the entitlement claims `applinks:botfleet.app`.  Batch B3a.
- **Packaged defaults point off-fleet.**  Composio broker `botfleet-composio.milindsoni201.workers.dev` (404), hosted sign-in `accounts.botfleet.com` (not a fleet zone), Team Library `milind-soni/botfleet-teams` (404).  Batch B3b.
- **fullAuto ACP bots cannot start a local-computer turn** (`localComputerMcp: false` → dispatch throws); 38 of 144 routine runs died on it; calendar routine turns are not marked unattended.  Batch B2.
- **The #82 rename broke phone trust:** iOS keychain service string and the companion device-directory migration were renamed without a migration.  Batch B4 (wave 2).
- **iOS CI is red on main** ("Build the iOS app (unsigned)") and `ios-testflight.yml` has failed 30 of 30 runs on every push.  Batch B6 (wave 2).
- **26 computer-subsystem tests fail** after PRs #117/#122 changed limits and readiness contracts.  Batch B9.

### 17.4  Revised Recommended Batches

The docx batches 2 and 3 have landed (#92, #91).  Batch 1 is narrower after #95/#119/#130 and finishes with retry-chip coverage plus a harness test.  Batches 4-6 landed in #95 pending re-verification.  The order that matters now:

1. **Land PR #130** so `main` compiles, boots, and tests again.  Everything else stacks on it.
2. **B1 harness-ops** — the fleet's always-on harness must run from `main`, and the desktop must attach to it rather than spawn a second harness on the same data directory.
3. **B2 automation-runs** — routines, triggers, and webhooks must be able to start a turn.
4. **B3a site-truth** and **B3b off-fleet-defaults** — public honesty and no third-party hosts by default.
5. **B5 trust-boundaries** — re-verify every #95 claim after the merges; fullAuto default off for Antigravity; phone room cwd containment.
6. **B9 computer-tests** — green CI gate.
7. Wave 2: **B4 phone-migration**, **B6 ios-ci**, **B7b mcp-fleet-tools**, **B8 webui-light**.

Process corrections for every seat: never resolve a merge conflict by keeping both sides; never merge with red CI; base new lanes on a green branch; keep the always-on harness on a detached `origin/main` checkout, not a seat's feature branch.


## 18.  Parent-Verified Facts

These were checked directly by the coordinating session, not by a sub-agent, and are ground truth for the report.

- **Audited HEAD:** `b34ac90` (PR #82).  Main advanced during the audit to `d710e40` (PR #84 native macOS menu bar + settings dedupe; PR #85 composer autofocus dependency).  Nothing in #84/#85 touches the findings below.
- **Always-on harness is dead.**  `launchctl print gui/501/com.jay.botfleet-server` shows 3,358 runs, last exit 1, KeepAlive.  `~/Library/Logs/botfleet/server.log` ends in `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode` at `server/resource-triggers.ts:252` (`constructor(private readonly options: …)`).  The same line is on `main`, so `pnpm dev:server` is broken for every seat while CI stays green (tsc + vitest transpile).  Port 8799 is served only by the GUI app's embedded server (pid of `/Applications/BotFleet.app`), so routines, webhooks, and resource triggers stop whenever the desktop app is closed.  Board `362daa42`.  The LaunchAgent's WorkingDirectory is `~/apps/botfleet-grok` @ `producer/fix-main-ci`, 18 commits behind main, and `~/apps/update-botfleet.sh` packages `/Applications/BotFleet.app` from that same stale worktree.
- **Live site regressed today.**  Vercel project `botfleet-site` (prj_m5bk3D75HzKZfIVSM3OmMx7WYwKz) has Root Directory `apps/site` in the BotFleet monorepo with build command `npm run build` (= `node build.mjs`).  PR #82's merge at 11:47:52 CDT produced deployment `dpl_14KxAz6FTRYqLW16Zip1m3779iNb` at 11:47:56 CDT, rebuilt from the monorepo's stale `apps/site/features.json`: TestFlight link `…/join/XYZ123` (placeholder), 3-bot roster, provenance states `open`.  The separate repo `jaywedgeworth22/botfleet-site` (main `91d8551`) holds the correct data (`ER6sPNMh`, 12-bot roster, states `merged`) and still deploys to the same Vercel project through its own `deploy.yml`, so whichever pushes last wins.  The public TestFlight beta link is `https://testflight.apple.com/join/ER6sPNMh`.
- **Release truth.**  On Sep 1 the only GitHub release was `jaywedgeworth22/BotFleet` v0.1.38 (two DMGs) and `jaywedgeworth22/botfleet-releases` returned 404, so the site CTA was the working link and every README download link was dead.  On Sep 2 at 03:20 UTC `jaywedgeworth22/botfleet-releases` was created with v0.1.38 (`BotFleet.dmg`, `BotFleet-intel.dmg`, `BotFleet-0.1.38-arm64.dmg`, `BotFleet-0.1.38-x64.dmg`); README and site links resolve.  Still no zip or `latest-mac.yml` on that release, `electron-builder.yml` publish still targets `milind-soni/botfleet-releases`, and `/Applications/BotFleet.app` has no `app-update.yml`, so in-app updates cannot succeed.  The separate `jaywedgeworth22/botfleet-site` repository was deleted on Sep 2; `apps/site` in the monorepo is now the only deploy source.  **Update (Sep 2, late evening):** by owner rule (one repository per app; agents never create repositories unless asked by name) PR #146 moved the publish target, `RELEASES_REPO`, the site download links, and the docs to `jaywedgeworth22/BotFleet`'s own Releases; `botfleet-releases` is retired and awaits owner deletion.  The missing `latest-mac.yml` + zips now belong on the v0.1.38 release of the BotFleet repo.
- **Universal links cannot work.**  `https://botfleet.app/.well-known/apple-app-site-association` is 404 (`agents.jays.services` returns 302).  The iOS entitlement lists both as `applinks`.
- **Docs site is not deployed.**  `https://botfleet.app/docs` is 404; `apps/docs` README still says import `milind-soni/BotFleet` and use `docs.botfleet.com`.
- **gh CLI auth is broken on this Mac** (env `GH_TOKEN` invalid, keyring invalid → HTTP 401 everywhere).  This blocks `apps/site/sync-status.mjs`, land-lane, auto-merge arming, and any bot routine that shells out to `gh`.  GitHub MCP, plain `git push` over SSH, and unauthenticated `curl` still work.
- **Sentry:** org `jays-services` has project `botfleet`; zero unresolved issues in the last 30 days.
- **GitHub state:** 0 open PRs, 1 open issue (#22, the prior audit), 75 merged PRs, all authored by the owner account.
- **THE BOARD:** 41 open/in-progress botfleet rows before this analysis; many findings exist twice (review-finding + effort-row, e.g. `e556f063` / `41ad27c9`).
- **Integration tree** `/Users/jay/Code/BotFleet` is dirty on `fix/ios-appicon-openmaus-branding` (uncommitted iOS icon work, an AG lane) — it is being used as a working lane, against the seat-worktree rule.  11 worktrees and ~30 local branches exist for this repo.
