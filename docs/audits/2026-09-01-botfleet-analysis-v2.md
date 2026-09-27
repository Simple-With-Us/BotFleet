# BotFleet Analysis v2 — 1 September 2026

> **2026-09-22 [MM] archaeology note:** historical references to `com.jay.botfleet-server` and `com.botfleet.app` kept verbatim as the bundle IDs that were live at audit time.  Both were renamed on 2026-09-22 (PR forthcoming): macOS app `app.botfleet.macos`, server LaunchAgent `app.botfleet.server`, iOS app `app.botfleet.ios`, iOS widgets `app.botfleet.ios.widgets`, Electron Recorder `app.botfleet.recorder.macos`, Electron Speech helper `app.botfleet.speech.macos`, plus the new app group `group.app.botfleet` and associated domain `botfleet.app`.  See `docs/rollouts/2026-09-22-bundle-id-migration.md`.

**Seat:** GROK pickup of CLAUDE.  **Branch:** `claude/analysis-v2` (not rebranded).  **Worktree:** `~/apps/botfleet-claude`.  **HEAD audited:** `6888f3e` (`origin/main`, includes #87–#92).  **Board:** `781554fd`.  **Issue:** #22 (audit series).  **Journal:** `wf_3ee20724-a39`.

**Method:** Claude's 16-finder workflow produced 238 raw findings, then the session limit killed verification round 2, the critic, and synthesis (`report: null`, `round2: 0`).  GROK salvaged the journal, treated every transcript claim as stale, merged `origin/main`, re-read current source, probed live Mac ops and public URLs, and reconciled with the owner Delta Audit docx.

**This lane is report-only.**  No product code.  Overlap with open GROK/AG implementation PRs is labeled "already in PR #N" rather than re-implemented.

---

## Counts

| Bucket | Count | What it is |
|---|---|---|
| Raw finder items | **238** | 16 specialists (electron, webui, harness, harness-security, ios-app, phone-path, cloudflare, site, docs-brand, drivers, mcp-server, cicd-release, fleet-protocol, fleet-capability, a11y-theme-copy, state-data). |
| Claude journal "alive" | 234 | Unreliable.  Round-2 verify, critic, and synthesize all `error`. |
| Claude techVerdict confirmed | **144** | Finder-pass claims a verify agent actually re-read.  Includes dupes. |
| Claude unverified | **89** | Verify agents died.  GROK sampled; did not rubber-stamp. |
| Claude refuted / already_fixed | 4 / 1 | Two of the four "refutes" are still true (stale update script; updater feed). |
| Unique after obvious dedupe | **~225** | Launchd crash-loop was filed 6 times; control-plane upstream 5 times. |
| Unique P0 still open on `6888f3e` | **5** | Fallbacks (narrower), hosted control-plane, Composio broker URL 404, routines 0/72, fullAuto vs local computer. |
| Unique P1 still open | **~28** | After dropping dupes and items landed in #91/#92. |
| Already claimed in a CODE PR or board row | **~22** | Do not double-fix.  See § Open implementation lanes. |
| New, not already claimed | **~12** | File follow-ups.  Do not start them in this analysis lane. |

Severity restatement: finders tagged 7 P0s.  Live TestFlight placeholder `XYZ123` is advertised-dead marketing (P1), not a crash or unauthenticated abuse of a shared secret.  The other six P0s collapse to five unique issues.

---

## Executive summary

BotFleet's loop still works when the desktop app is open: message, bot, stream, tools, approvals, computer.  Pairing, the 127.0.0.1 Host/Origin gate, and write-only API-key UI remain the parts this report would not touch.

What is in bad shape is the gap between advertised automation and the Mac that actually runs the fleet.

1. **The always-on harness is not always on.**  `com.jay.botfleet-server` has KeepAlive-crash-looped **4,208** times (Node 26 `--experimental-strip-types` hitting a TypeScript parameter property in `~/apps/botfleet-grok/server/resource-triggers.ts`).  Ports 8799/8800 are served only by `/Applications/BotFleet.app` (PID observed during this pass).  That CODE bug is already claimed (`362daa42`).  **Do not fix it here.**  Origin/main already uses `constructor(options)` without a parameter property.  Live is stale because `update-botfleet.sh` builds from `~/apps/botfleet-grok` on `producer/fix-main-ci`.

2. **Advertised automations have never succeeded on this Mac.**  `~/.botfleet/routines.json` has **72 runs, 0 ok, 64 fail, 8 missed**.  Dominant errors: `store.task is not a function` (stale packaged app) and `this model engine cannot control this computer` (still thrown on main when `computer=local` and the engine sets `localComputerMcp: false`, which fullAuto ACP instances do).

3. **Hosted phone path and Composio defaults point off-fleet.**  Packaged desktop defaults hosted sign-in to `https://accounts.botfleet.com` (live 204, Cloudflare account `0c92969a…` is not a fleet account).  Composio defaults to `https://botfleet-composio.milindsoni201.workers.dev` (live 404).

4. **Downloads and auto-update have no public feed.**  `electron-builder.yml` publishes to `milind-soni/botfleet-releases` (404).  README and the owner Batch 4 PR aim at `jaywedgeworth22/botfleet-releases`, which also 404s for this token.  "Check for updates" cannot succeed.

5. **Owner Delta Audit batches 2 and 3 have landed on main** (#92 ATS + iOS light, #91 Electron open-file / window-open).  Batch 1 (fallbacks) is narrower after #89, not closed.  Batches 4–6 are in open GROK PRs #94/#95.

Recommended posture: do not open a third implementation wave from this report.  Finish the claimed CODE lanes.  File the new P0s that are not already on THE BOARD.  Rebuild the always-on harness from `origin/main` so routines and Housekeeper stop depending on a GUI window.

---

## Method, scope, and limits

### What Claude finished

Workflow `botfleet-full-analysis` / `wf_3ee20724-a39`.  160 agents, ~14M tokens, ~977 tool calls, ~19 minutes.  Find phase completed (16 reviewers, 238 items).  Verify phase started then mostly `error`.  Gaps critic and synthesize `error`.  Result payload: `report: null`, `boardItems: []`, `round2: 0`.

### What GROK did

- Merged `origin/main` into `claude/analysis-v2` (fast-forward `d710e40` → `6888f3e`).
- Re-read current `server/index.ts` fallback gate, `electron/main.mjs` + `electron/open-file.mjs` + `electron/external-url.mjs`, `ios/project.yml`, `apps/site/features.json`, `cloudflare/*/wrangler.jsonc`, `SECURITY.md`, `server/telemetry.ts`, `server/resource-triggers.ts`, `server/auto-approve.ts`, `server/store.ts` `deleteBot`, group PATCH, stall watchdog.
- Live: `launchctl print` on `com.jay.botfleet-server`, plist, last log lines (redacted), `lsof` :8799/:8800, `update-botfleet.sh`, `/Applications/BotFleet.app` version, HTTP HEAD on broker / control-plane / TestFlight / releases / AASA.
- Reconciled with `/Users/jay/Desktop/BotFleet-Delta-Audit-2026-09-01.docx` (owner delta vs Aug 31, HEAD `b34ac90`).
- Mapped open PRs #83, #86, #90, #94, #95, #96 and merged #87–#92.

### What this is not

- Not a device TestFlight or packaged-app smoke of every viewport.
- Not a license to extra-ship product code from this branch.
- Not a fix for `362daa42` (launchd crash-loop).
- Slack `#agent-sync` skipped (`account_inactive`).  Board comment on `781554fd` is the claim.

Journal and tool output from the capped session were treated as untrusted.  Line numbers in finder evidence (for example `resource-triggers.ts:252`) no longer match main.

---

## Reconciliation with the owner Delta Audit (docx)

Owner document: Desktop `BotFleet-Delta-Audit-2026-09-01.docx`.  Baseline `docs/audits/2026-08-31-full-stack-audit.md`.  Owner HEAD was `b34ac90` (after #82).  This v2 HEAD is `6888f3e`.

| Owner item | Owner status at `b34ac90` | GROK status at `6888f3e` |
|---|---|---|
| P0-1 fallbacks | PARTIAL.  Error chips ignored.  Tool activity and rooms still block. | Still PARTIAL.  #89 also ignores short streamed text that looks like a quota/5xx.  `turn.retrying` chips still have `ok: true`, and `produced` still counts `activity` with `tool.ok !== false`.  Rooms still skip the gate (`if (bot)`).  Board `e556f063`.  AG #90 is a different failover feature — do not treat it as this gate. |
| NEW-ATS | NEW P1.  PR #81 `NSAllowsArbitraryLoads`. | **FIXED** in #92.  Current `ios/project.yml`: `NSAllowsLocalNetworking` + `ts.net` insecure exception only.  `preferredColorScheme(.light)` on `CompanionApp`. |
| W11 / W12 Electron trust | OPEN.  #31 title over-claim. | **FIXED** in #91.  `windowOpenExternalUrl` http(s) only.  `resolveOpenablePath` confined like save-file.  Node test `electron/open-file.node-test.mjs`. |
| W3 / W4 light-first | PARTIAL.  JS Studio.  CSS Midnight.  iOS system. | iOS light pinned (#92).  `getDefaultSkin()` is `"studio"`.  `electron/main.mjs` `backgroundColor` is `#f6f8fa`.  CSS `@theme` defaults are still Midnight `#070707` (FOUC).  Board `961d2d50`. |
| C7 downloads | OPEN.  Site CTA → source-repo Releases. | Site `index.html` still points Download at `github.com/jaywedgeworth22/BotFleet/releases`.  README already uses `jaywedgeworth22/botfleet-releases` tag `v0.1.37`.  **That releases repo 404s.**  PR #95 retargets the CTA, but cannot succeed until the repo exists and has artifacts.  Board `d9bd4316`. |
| C1 Composio open registration | OPEN. | Still `REGISTRATION_MODE: "open"` on main.  Already in GROK PR #95. |
| C3 / C4 / D2 companion leftovers | OPEN. | Already in GROK PR #94. |
| W9 deleteBot ghosts / I3 avatarCrop / W16 VM stall / W15 pipe-to-shell / W5 drafts | OPEN. | Still open on main.  Already claimed on THE BOARD (`96d7de9b`, `4cb4ec63`, `a5dabdea`, `cd6bf0cd`, `dfb0d844`). |
| I1 iOS model save | FIXED. | Still fixed. |
| W1 / W2 composer paste | FIXED. | Still fixed. |
| TEL / SEC / HAND | OPEN / PARTIAL. | SECURITY.md still names upstream Gmail and plaintext `config.json`.  `server/telemetry.ts` still reads `~/.secrets/global-api-keys`.  PR #95 covers SECURITY.md.  Board `12c3674f` / `8e266add`. |
| LOG effort-log In Progress after merge | NEW. | Live board has been corrected for #65/#80 and #55.  Repo `docs/EFFORT-LOG.md` on this worktree was still stale until this PR. |

Owner batches vs now:

1. Fallbacks — still the product P0.  Claimed `e556f063`.  #89 helped.  #90 is not this gate.
2. ATS rollback — **landed #92.**
3. Electron trust — **landed #91.**
4. First-run light, copy, version — PR #95 (honesty/docs).  CSS `@theme` not in that PR.
5. Data and permissions — still claimed, not landed.
6. Hygiene — PR #95.

v2 adds issues the owner docx did not have, because they are live-ops or appeared after `b34ac90`: launchd crash-loop, stale update script, missing `botfleet-releases` repo, hosted `accounts.botfleet.com`, Composio URL 404, routines 0/72, fullAuto vs local computer, AASA 404, iOS AppIcon not in the XcodeGen target, #82 keychain/dir migration.

---

## What landed on main after the finders ran

Finders read roughly `b34ac90`.  These merges changed the board before this report:

| PR | Title | Effect on this analysis |
|---|---|---|
| #87 | DeepSeek logo, cursor image path, hide HTTP drivers in CLI | Partial on D3/D4 UI.  Pricing table still stale.  PR #86 still open. |
| #88 | Sentry Vercel DSN, Feedback, harness gen_ai spans | Weakens "Sentry web is inert" for production builds that set `VITE_SENTRY_DSN`.  Does not add a React error boundary. |
| #89 | Fallback on streamed error **text** | Narrows P0-1.  Retry chips and tool activity still count as `produced`. |
| #91 | Confine open-file and window-open | Closes owner W11/W12.  Board `6c38e297`. |
| #92 | Roll back ATS arbitrary loads, pin iOS light | Closes owner NEW-ATS and I7.  Board `95e445e5`. |
| #84 / #85 | Mac menu bar; composer `bot?.threadId` autofocus | Unrelated polish.  Keep. |

---

## Open implementation lanes (do not duplicate)

| PR / board | Owns | Notes |
|---|---|---|
| **#94** `grok/delta-companion-trust` | C3 pairing replay after revoke, C4 phone `always-allow` / connector authorize, D2 DSH `--mcp` quoting | Main still has those allowlist rows in `companion/src/routes.ts`. |
| **#95** `grok/delta-audit-fixes` | Site Download CTA, `--ink-muted`, README fork copy, example fleet 3–5, Composio `REGISTRATION_MODE=closed`, SECURITY.md, effort-log hygiene | Mergeable_state dirty vs newer main.  Cannot fix missing `botfleet-releases` repo by docs alone. |
| **#90** AG model failover + Gemini tools + Qdrant RAG | Different failover path (quota / session limits) | Do not close `e556f063` on this PR without re-reading the `produced` gate. |
| **#96** AG iOS fallback provider dropdowns | iOS UI for chains that still do not run | |
| **#86** DeepSeek UI 2 | Prices / retired ids | Board `19420079`. |
| **#83** iOS AppIcon + OpenMaus leftovers | Icon catalog not in any XcodeGen target | Confirmed: `ios/project.yml` sources `App` + `Shared` only.  `ios/Assets.xcassets/AppIcon.appiconset` exists on disk. |
| `362daa42` | Launchd crash-loop | Mention only.  Main already dropped the parameter property.  Live worktree has not. |
| `e556f063` | Fallback `produced` gate | Still the owner P0. |
| `a5dabdea` | Local VM stall lease | `onStall` still does not call `releaseLocalVmThread`.  Only `turn.completed` does. |
| `cd6bf0cd` | Auto-approve pipe-to-shell | `DESTRUCTIVE` has no `curl|sh` / pipe-to-interpreter rule.  Always-allow is still program-scoped (`Bash:curl`). |
| `96d7de9b` / `4cb4ec63` / `dfb0d844` / `dc5c9b87` / `961d2d50` | deleteBot ghosts, group `avatarCrop`, drafts listener, hydrate races, CSS Midnight FOUC | Still true on main. |
| `a9683ae2` | iOS chat image path shape | Still claimed on the iOS delta worktree. |
| `94850736` / `d9bd4316` / `12c3674f` | Broker open, download CTA, SECURITY.md | Inside #95. |
| `02ca3c98` / `12ccfacd` / `80dd2680` / `92a254df` | Closed-app push, Open-from-iOS, iMessage relay drift, error-to-recovery | Unchanged.  Do not pretend Live Activities with `pushType: nil` cover closed-app. |

---

## P0 — still open (unique)

### 1. Model fallbacks still die on retry chips and rooms

- **Where:** `server/index.ts` `turn.retrying` (~1330) and `turn.completed` `produced` (~1410).
- **Evidence:** Retry chip is `kind: "activity"` with `tool.ok: true`.  `produced` is true if any later bot message is `kind === "text" && !isTextError` **or** `kind === "activity" && tool.ok !== false`.  Group turns never enter the block (`if (bot)`).
- **Impact:** Settings still offers "+ Add Fallback Model".  botfleet.app still sells the chain.  A 429 that the driver retries once will not fail over.  A room member never fails over.
- **Already claimed:** `e556f063`.  #89 landed.  #90 is not this gate.
- **Confidence:** high (re-read on `6888f3e`).

### 2. Packaged app trusts `accounts.botfleet.com` (not a fleet zone)

- **Where:** `electron/companion-account-service.mjs` `DEFAULT_COMPANION_CONTROL_PLANE_URL`; `cloudflare/control-plane/wrangler.jsonc` account `0c92969a82eb9e173b013a7e7a02333d`, zone, `EMAIL_FROM=noreply@botfleet.com`.
- **Evidence:** `GET https://accounts.botfleet.com/healthz` → **204**.  Fleet Cloudflare MCP accounts are Congress.Trade / SocraticTrade.com / Usage.Jays.Services.  None of those IDs match the wrangler `account_id`.
- **Impact:** Hosted "Secure access" / phone HTTPS is either undeployable by this fleet or talks to upstream's control plane.  Pairing and device traffic must not leave Jay's accounts by default.
- **Not claimed** on THE BOARD as its own P0 (docs-brand/cloudflare finders filed it; no CODE PR).
- **Confidence:** high.

### 3. Default Composio broker URL is a 404

- **Where:** `electron/main.mjs` `DEFAULT_COMPOSIO_BROKER_URL = "https://botfleet-composio.milindsoni201.workers.dev"`.
- **Evidence:** Live HEAD → **404**.  `REGISTRATION_MODE=open` on main is a separate issue (PR #95).
- **Impact:** Packaged desktop "Connected apps" against the default URL cannot register.
- **Overlap:** `94850736` / #95 close registration.  They do not change this default URL.
- **Confidence:** high.

### 4. Scheduled / trigger / webhook wakes: 0 successes

- **Where:** live `~/.botfleet/routines.json` (counts only; no prompt bodies in this report).  Throw site on main: `server/index.ts` ~2009.
- **Evidence:** 72 runs: 0 ok, 64 fail, 8 missed.  Fail classes: `store.task is not a function` (30; stale `/Applications/BotFleet.app` 0.1.38 built from `producer/fix-main-ci`) and `this model engine cannot control this computer` (21; still on main).  CUA-not-ready (7) is the same computer mount when the GUI driver is down.
- **Impact:** Overnight board, Housekeeper disk watch, PR health sweep, Sentry/PD watch — every fleet-procedure routine — has never completed.  Site lists routines as Established.
- **Causal chain:** launchd dead → GUI-only harness → stale branch → `store.task` + fullAuto local-computer throw.
- **Not a separate CODE PR.**  Fixing `362daa42` + rebuilding from main removes the `store.task` class.  P0-5 remains.
- **Confidence:** high.

### 5. fullAuto ACP instances cannot start a local-computer turn

- **Where:** `server/drivers/acp/core.ts` ~744 `localComputerMcp: !config.fullAuto`.  Same pattern in `antigravity.ts`, `pi.ts`, Claude bypass.  Dispatch throw: `server/index.ts` ~2004–2009.
- **Evidence:** Tests in `server/drivers/acp/acp.test.ts` assert fullAuto → `localComputerMcp === false`.  Live routine errors match the throw string.
- **Impact:** A Grok/Kimi/Cursor/DSH (or bypass-mode Claude) bot with `computer=local` and fullAuto cannot start.  Fleet bots that are supposed to run unattended on this Mac are in that set.
- **Not claimed** as its own board row (finder `fleet-capability:fullauto-acp-bots-cannot-start-any-turn-with-local-computer`).
- **Confidence:** high.

**Demoted from finder P0:** live TestFlight CTA `join/XYZ123` is HTTP 404.  README already has working `join/ER6sPNMh` (200).  Treat as P1 marketing honesty, already adjacent to #95 / `d9bd4316`.

---

## P1 — unique remaining (grouped)

### Live Mac / release (new or only half-claimed)

| ID | Title | Status |
|---|---|---|
| launchd cluster (6 finder IDs) | `com.jay.botfleet-server` runs=4208, last exit 1, cwd `~/apps/botfleet-grok` | **Claimed `362daa42`.**  Main is already strip-types-safe.  Live plist is not on main. |
| `electron:installed-app-and-update-script-track-grok-branch-not-main` | `update-botfleet.sh` `cd ~/apps/botfleet-grok && git pull` on whatever branch is checked out (`producer/fix-main-ci`) | Confirmed.  Claude "refute" was wrong.  Pair with 362daa42; do not start a third lane. |
| `electron:in-app-updater-has-no-feed-anywhere` | `electron-builder.yml` `owner: milind-soni` / `repo: botfleet-releases` (404).  `jaywedgeworth22/botfleet-releases` also 404s. | Confirmed.  Create the public releases repo, publish `latest-mac.yml`, retarget builder.  #95 docs cannot create the repo. |
| `electron:release-workflow-mac-signing-fails-and-targets-milind-repos` | `release.yml` has never produced a Jay-owned feed | Carried.  Same cluster as updater. |
| `cicd-release:no-branch-protection-prs-merge-red` | Finders: main has no protection; PRs merge red | Process.  Owner already wants green CI.  Not a product patch in this lane. |
| `cicd-release:ios-testflight-workflow-dead` | `ios-testflight.yml` 30/30 fail on push to main | Ops.  Do not fire a broken workflow on every main push. |
| `state-data:dual-harness-same-data-dir-no-lock` | GUI embedded server + launchd (when it works) + iMessage relay spawn share `~/.botfleet` with no lock | Confirmed risk.  Last writer wins on JSON stores. |

### Trust / companion (claimed or overlapping)

| ID | Title | Status |
|---|---|---|
| `harness-security:auto-approve-pipe-to-shell-still-open` | W15 | Open.  `cd6bf0cd`. |
| `harness-security:fullauto-defaults-bypass-permission-broker` | Antigravity `fullAuto` defaults true (`--dangerously-skip-permissions`) | Related to P0-5.  Product decision, not a drive-by. |
| `harness-security:scheduled-routine-turns-not-unattended` | Calendar wakes are not marked unattended, so Auto/Always-allow still fire | Confirmed as a design hole next to 0/72 successes. |
| `harness-security:phone-room-cwd-widening` | Paired phone can set a room cwd to any existing directory | Confirmed as claimed-adjacent to C4.  #94 does not mention cwd. |
| `phone-path:companion-legacy-dir-migration-typo` / `ios-keychain-service-renamed-without-migration` | #82 rename broke device dir + keychain service string | New.  Updated phones restore as unpaired.  Not in #94. |
| `ios-app:ios-appicon-not-in-any-target` | AppIcon catalog not in XcodeGen sources | **Already in PR #83.** |
| `ios-app:ios-associated-domains-dead` / `site:site-aasa-missing-universal-links-dead` | No `apple-app-site-association` on botfleet.app (404).  Entitlement still claims applinks. | Confirmed.  Not claimed. |
| `cloudflare:composio-broker-registration-open-ua-keyed-limiter` | C1 | **PR #95.** |
| `docs-brand:team-library-catalog-404` | Catalog host `milind-soni/botfleet-teams` 404 | Confirmed.  Team Library empty. |
| `docs-brand:security-contact-upstream-author` | SECURITY.md → `soni.mil2001@gmail.com` | **PR #95.** |
| `harness:local-vm-stall-idle-fence-leak` | W16 | Open.  `a5dabdea`.  `onStall` still no `releaseLocalVmThread`. |

### Desktop / iOS product (already on the Aug 31 / delta boards)

deleteBot ghost `memberIds`, group PATCH drops `avatarCrop` (store accepts the field; HTTP PATCH never copies it), drafts `useState` listener, hydrate / `setModel` / unread races, CSS Midnight `@theme`, iOS image `/api/attachments` URLs, closed-app push, Open-from-iOS, iMessage LaunchAgent vs host-script drift, error-row recovery cards.

All still true on `6888f3e`.  All already have board IDs.  Do not refile.

### A11y P1

`a11y-theme-copy:code-fence-dark-shiki-on-light-default` — code fences still `github-dark-default` on Studio.  Unreadable on the light default the owner required.  Not claimed.

---

## Fleet-procedure integration

This was an explicit owner ask (Mac app + iOS + site + **coding development procedures**).

| Finding | Evidence | Disposition |
|---|---|---|
| Always-on harness is the GUI app | launchd 4208 crashes; `lsof` :8799 = `BotFleet` | Claimed `362daa42`.  Rebuild from main. |
| Fleet routines never complete | 0/72 | P0-4.  Blocks Housekeeper, Overnight board, PR Health Sweep. |
| `AGENTS.md` hardcodes `[AG]` | Line 20 | P2 docs.  Seat-agnostic stanza is in `AGENT-SYNC.md`. |
| Shared `~/Code/BotFleet` used as a lane | Finder + fleet keepout | Binding: work in `~/apps/botfleet-*`.  This pickup stayed in `~/apps/botfleet-claude`. |
| No per-bot worktree isolation | Channels pin `/Users/jay/Code/<repo>` | Improvement.  Do not invent a matrix in this PR. |
| `gh` token invalid in this seat | User note; land via GitHub MCP | Process.  Same class as finder `fleet-capability:gh-auth-broken-blocks-pr-procedures`. |
| Slack `account_inactive` | Agent-sync poll `ERR account_inactive` | This report used THE BOARD only. |
| Product server reads fleet handoff file | `server/telemetry.ts` `loadSecretKey` | Board `8e266add`.  Infisical is canonical for runtime. |
| MCP server exists, fleet seats are not wired | `scripts/mcp-server.ts` | P2.  `list_pending_approvals` still missing (`02ca3c98` adjacent). |
| Repo skills are not what bots load | Finder `fleet-capability:fleet-skills-and-mcp-claim-not-wired-to-bots` was marked refuted | Treat as P2 until a seat demonstrates a bot actually loading `.claude/skills`.  Do not advertise "Fleet MCP Tools & Standard Skills" as Established. |
| Site publishes an effort-log copy | `apps/site/docs/EFFORT-LOG.md` | P2 honesty / data.  Finder unverified; path exists in tree. |

---

## P2 themes that must not be dropped

**Honesty / marketing**

- Live botfleet.app TestFlight = `XYZ123` (404).  Working code is `ER6sPNMh`.
- Hero still "Built on OpenMausBot".  README fork paragraph is circular (PR #95).
- `features.json` provenance almost every card cites PR #5 `state: "open"`.
- Example fleet still Director / Builder / Reviewer (owner rule: 3–5 peers, no hierarchy).
- Docs app undeployed (`docs.botfleet.com` / `botfleet.app/docs` 404).
- FUNDING.yml still Polar for the upstream author.

**Drivers**

- DeepSeek API driver and credential card survived "removal".  ACP `deepseek.ts` is a kimi copy.  PR #86/#96 touch UI, not this.
- OpenAI-compat streamed turns do not request usage.
- Grok API `cost: null`.  Claude catalog missing `claude-fable-5-1`.
- Fallback telemetry attributed to the primary engine.

**State / disk**

- No runtime backup.  Updater `pkill -9` mid-write.
- `deleteBot` `rmSync` of workspaces with no size warning (finder: 1.7 GB clones).
- Orphan `events/` + `native/` ndjson; one native tee file was 205 MB.
- `routines.json` save is not `writeFileAtomic`.
- `bots.json` / `groups.json` 0644 vs 0600 elsewhere.

**iOS / site**

- App Store metadata / privacy answers still "no analytics SDKs" after Sentry Cocoa.
- `TARGETED_DEVICE_FAMILY: "1"` while copy says iPad.
- Site `index.html` is a committed build artifact.
- No CSP / Referrer-Policy on botfleet.app (HSTS only).

**A11y / copy**

- Sentence-gap misses (finder: 91 desktop + 39 iOS).  This file uses two ASCII spaces.
- Settings modal fixed `h-[560px]` clips at Electron minHeight 600.
- Six extra skins fail `check-skin-contrast.mjs`; checker not in CI.
- `pnpm lint` anti-slop is huge and not in CI.

---

## Already solid (do not "fix")

- Harness bind `127.0.0.1` + loopback Host/Origin gate.
- API keys UI write-only (`configured` flags).
- Device tokens hashed; pairing 32-byte QR + 6-digit fallback with lockout.
- iOS Keychain `AfterFirstUnlockThisDeviceOnly` (service string migration is the remaining hole).
- `save-file` containment + `O_NOFOLLOW`.  **open-file now matches** (#91).
- Desktop viewer sandbox + HTTPS/loopback URL check.
- Linux Wayland host control fail-closed.
- Paired `/profile` refuses `autoApprove` / `computer` / `alwaysAllow`.  Do not widen.
- Sentry project `jays-services/botfleet` exists (#44, #55, #88).  Do not stand up a second project.
- iOS modelSelection encodes (I1).  Composer paste (W1/W2).  JS default skin Studio.  ATS rolled back (#92).

---

## Recommended next (do not start all)

Analysis lane stops here.  Implementation seats should claim on THE BOARD first.

**A. Unblock the Mac that runs the fleet** (ops + already-claimed CODE)

1. Point `com.jay.botfleet-server` at a main-tracking checkout (or `dist-server`) — `362daa42`.  Origin/main is already strip-types-safe.
2. Change `update-botfleet.sh` to `fetch` + detach `origin/main`.  Refuse a dirty / non-main worktree.
3. One harness lock on `~/.botfleet`.  Stop the iMessage relay from spawning a second `index.ts`.

**B. Make advertised automation true** (product P0)

4. Fallback `produced` = assistant `kind === "text"` (or successful terminal tool), including rooms — `e556f063`.  Do not close this on AG #90 without a harness test that a retry chip does not block the next `instanceId`.
5. Decide local-computer + fullAuto: either mount local MCP in bypass (and say so) or refuse the combination in Settings before dispatch.

**C. Stop talking to the wrong hosts** (new P0s)

6. Default control-plane URL → a fleet-owned host, or hide hosted HTTPS until that Worker is deployed on a Jay account.
7. Default Composio URL → a Worker this fleet actually serves, or empty-with-setup.  #95 closing registration is not enough if the URL 404s.
8. Create public `jaywedgeworth22/botfleet-releases`, upload dmg/zip + `latest-mac.yml`, retarget `electron-builder.yml`.  Then #95's Download CTA can work.

**D. Already-claimed product P1s** — land #94, #95 (rebase), #83, then Batch 5 (deleteBot, avatarCrop, VM stall, pipe-to-shell, drafts).  Do not mix with A–C.

**E. Cheap honesty** — TestFlight `ER6sPNMh` on the live site; AASA or drop applinks; Team Library catalog host; SECURITY.md (in #95); stop reading `~/.secrets/global-api-keys` from the product server.

Acceptance the owner can run without reading code:

- Quit BotFleet.app.  `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8799/api/health` is 200 from launchd, not from the GUI.
- Bot with Grok primary + Claude fallback: force a 429 after a retry chip.  Claude takes the next beat.  Repeat in a room.
- Packaged Composio default does not 404.  Hosted companion URL is a `jays.services` / fleet zone, or the feature is hidden.
- botfleet.app TestFlight opens `ER6sPNMh`.  Download fetches `BotFleet.dmg` from `jaywedgeworth22/botfleet-releases`.
- `javascript:` from chat markdown does not open (already #91).  ATS: cleartext to botfleet.app is rejected (already #92).

---

## Compact register (v2 vs owner docx vs main)

Status vs HEAD `6888f3e`.  "PR #N" means an open implementation PR, not this analysis PR.

| ID | Sev | Status | One-line |
|---|---|---|---|
| P0-1 | P0 | PARTIAL | Fallbacks.  #89 text-errors.  Retry chips + rooms still block.  `e556f063`. |
| P0-CP | P0 | NEW | Default hosted control-plane is `accounts.botfleet.com`. |
| P0-BRK | P0 | NEW | Default Composio URL 404.  Distinct from C1 open registration. |
| P0-RTN | P0 | NEW | Routines 0/72.  Stale app + P0-5. |
| P0-FA | P0 | NEW | fullAuto ⇒ `localComputerMcp: false` ⇒ dispatch throw. |
| NEW-ATS | P1 | **FIXED #92** | Arbitrary loads gone.  `ts.net` only. |
| W11/W12 | P1 | **FIXED #91** | Window-open http(s).  open-file confined. |
| W3/W4 | P1 | PARTIAL | JS Studio, Electron light chrome, iOS light.  CSS `@theme` Midnight. |
| W5–W10 | P1 | OPEN | drafts, hydrate, setModel, unread, deleteBot ghosts, patchGroup.  Claimed. |
| W14/W15/W16/W17 | P1 | OPEN | control-client, pipe-to-shell, VM stall, recovery cards.  Claimed. |
| I1 | P1 | FIXED | iOS modelSelection. |
| I2 | P1 | OPEN | iOS image path.  `a9683ae2`. |
| I3 | P1 | OPEN | Group avatarCrop dropped on HTTP PATCH.  `4cb4ec63`. |
| I4 | P1 | OPEN | Closed-app push.  `02ca3c98`. |
| I6 | P2 | OPEN | iPhone-only, site may still say iPad.  #95. |
| I7 | P1 | **FIXED #92** | `preferredColorScheme(.light)`. |
| C1 | P1 | OPEN | Broker registration open.  **#95**. |
| C3/C4/D2 | P1 | OPEN | **#94**. |
| C6/C7 | P2/P1 | PARTIAL | README tag 0.1.37.  Releases repo 404.  Site CTA still source-repo.  **#95**. |
| D3/D4 | P1/P2 | OPEN | DeepSeek prices / retired ids.  **#86**. |
| TEL/SEC/HAND | P2 | OPEN | Badge, SECURITY.md, handoff file.  **#95** + `8e266add`. |
| launchd | P1 | OPEN | Live crash-loop.  Main already fixed.  `362daa42`. |
| updater | P1 | NEW | No public feed anywhere. |
| AASA | P1 | NEW | Universal Links entitlement without a file. |
| AppIcon target | P1 | OPEN | **#83**. |
| #82 migration | P1 | NEW | Keychain + companion dir.  Not in #94. |
| TestFlight XYZ123 | P1 | OPEN | Live site 404.  README is correct. |
| code fences | P1 | OPEN | Dark Shiki on Studio. |

---

## Sources

- Journal: `/Users/jay/.claude/projects/-Users-jay-Code-BotFleet/b119bbb6-59d8-4dad-9147-9fd45efcaf7d/workflows/wf_3ee20724-a39.json`
- Repository: `github.com/jaywedgeworth22/BotFleet` HEAD `6888f3e`
- Baseline: `docs/audits/2026-08-31-full-stack-audit.md` and issue #22
- Owner delta: `/Users/jay/Desktop/BotFleet-Delta-Audit-2026-09-01.docx`
- Site: https://botfleet.app (TestFlight `XYZ123`, Download → source-repo Releases)
- TestFlight working: https://testflight.apple.com/join/ER6sPNMh
- Board: `781554fd` (this analysis), plus IDs in § Open implementation lanes

This document is read-only analysis.  It is not an owner instruction to start every batch at once.

Co-authored with Claude's finder pass (`wf_3ee20724-a39`).  Verification, critic, and synthesis are GROK's.
