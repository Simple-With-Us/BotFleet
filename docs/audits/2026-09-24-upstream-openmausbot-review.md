# Upstream OpenMausBot Review: What To Learn From And Borrow

Date: Thu, Sep 24, 2026 (Central Time).  Seat: Claude.  Board row `ab19befc` (P2, agent-report).  Trees compared: BotFleet `origin/main` at `10de731b` and `milind-soni/OpenMausBot` `main` at `dbd7920c` (v0.1.87, released Sep 24), both read from detached worktrees.  Read-only; nothing changed in any lane.

## Scope And Method

The owner asked for a thorough review of updates to the upstream OpenMausBot repository since BotFleet forked, to find what BotFleet can learn from and borrow.  Three read-only workers covered the server runtime and drivers, the product and mobile UX, and infrastructure, packaging, and the companion, each triaging the merged PR list and release notes, then reading code in both trees.  The coordinator measured the structural divergence and the license boundary.

Inputs: 698 merged upstream PRs since Aug 31 (`gh pr list`), 190 open upstream issues, release notes v0.1.38 through v0.1.87, and both trees.

## Executive Summary

Upstream OpenMausBot is moving faster than BotFleet can track by patching: 698 merged PRs and 49 releases in the 24 days since the fork, a rewritten prompt pipeline, a headless self-hosting stack, an Android app, eight-language localization, and an open-core `enterprise/` carve-out under a non-Apache license.  BotFleet's history has no common ancestor with upstream's, and the trees have diverged in most files, so "borrowing" means re-implementing from upstream's code as a reference, except for a set of small pure modules that drop in whole.

Three conclusions:

1. **BotFleet is ahead in several areas and should not port backwards.**  APNs delivery, Sentry on every surface, the transactional Mac updater, the 1,064-line secret redactor, CI path scoping, Usage Monitor telemetry with cache-token accounting, the extra engines with multi-tier fallback, nested conversations, and multi-repo channels have no upstream equivalent.
2. **A dozen upstream pieces are small, Apache-licensed, and answer findings in the efficiency audit directly.**  Five are already being folded into the running fix lanes (the Chief roster fix, the extra secret prefixes, the thread-retention sweep, the resume-recovery classifier, the paged thread reader); the rest are queued below.  One is a new security gap: BotFleet forwards every Composio tool call with no per-bot grant check.
3. **The two structural ideas worth planning for are the stable-prefix prompt split and a headless companion.**  The first is the real fix for prompt-cache waste across every engine; the second is the real fix for the phone path dying with the desktop app.  Both are medium-to-large lifts that need their own design notes.

## What To Borrow, In Order

**Now (small, Apache, addresses an audit finding; in flight or queued for the fix lanes)**

1. Drop live busy state and the timestamped status capsule from the Chief system prompt (A, A2; DR1).  In flight in `claude/fix-drivers`.
2. Add `xai-`, `gsk_`, `hf_` to the secret redactor (Q).  In flight in `claude/fix-hotpath`.
3. Port `thread-retention.ts`'s sweep and safety rule (G; HS1).  In flight in `claude/fix-persistence`.
4. Port `resume-recovery.ts` and make boot recovery ask "can I prove the provider never saw this prompt?" (F; HS18).  In flight in `claude/fix-boot`.
5. Port `readThreadTail` paging for the thread cache (R; HS12).  Queued for the memory lane.
6. Port `connector-verdict.ts` with a per-bot `connectorTools` field and enforce it in `connector-proxy.ts` (H).  New security package.
7. Renewable idle deadline for ACP `session/prompt` (J).  Queued for the drivers lane or its follow-up.
8. Fix the skills index cap that silently drops enabled skills (#1686, present verbatim in `server/skills.ts`).  Queued with H.
9. Port `electron/update-errors.mjs` and add a release-completeness check modelled on `sync-published-release.yml` (issue #285, UI4).  Queued for the ops lane's follow-up.
10. Small UI wins: the digest chip, the teammate-wait status chip, the bounded reasoning window, the routine calendar preview, and GFM tables and task lists on iOS.

**Next (medium; each needs a short design note first)**

11. The stable-prefix prompt split (B, C, D, E) with `promptBytes` accounting (P), sequenced: contracts fields, a `PromptPart[]` builder extracted from `server/index.ts:3493-3529`, `prompt-split.ts`, Claude, the three HTTP drivers, Codex, ACP.
12. Durable steer and channel follow-ups restored on boot (M), then the delegation ledger so a handoff to a busy peer queues instead of dead-ending (L).
13. Command allowlist (I) and thread snooze (desktop and mobile).
14. Mermaid diagrams and preset bots (file-import path only).
15. Evals harness (O), a verification-recipe library pointed at from `AGENTS.md`, per-issue requirements notes, and CI as sharded jobs behind one synthetic gate with a merge queue.
16. A headless companion entry so the phone path can run under launchd without the desktop app (the scoped BotFleet version of upstream's `serve --tunnel`; IO21).

**Watch (open upstream, no merged code yet):** harmonized admission and drain coalescing (#1806 to #1809), tightening-only bot settings proposals (#1785 to #1795), voice-note bubbles (#1743, #1744), config validation warning (#1797), skills.sh import (#1782), peer delivery receipts and live-peer rosters (#1803, #1811, #1812), Windows and Linux voice calls (#1813), naming the missing macOS permission during onboarding (#1704).

**Skip:** everything under `enterprise/` and the organisation features behind it; localization (single English-speaking owner); the Android app; team package v2 (BotFleet's team library has diverged); the sidebar restructure (BotFleet's monolith carries fleet-only features); HPKE pairing (later, with NOTICE lines); Cua Driver 0.28.2 (a stale upstream branch, not a release).

## What Upstream Could Use From BotFleet

For the owner's decision only; the fleet rule forbids external contact without per-case approval.  Portable candidates that meet upstream's contribution checklist: the APNs sender with its breaker (once the fixes in `claude/fix-apns` land), the transactional Mac updater, the tightened retry classifier, the transcript-retention orphan sweep, the async event tee, and the CI path-scoping job.  Each would need the fork-specific paths, names, and endpoints stripped and the upstream comparison commit recorded, as `CONTRIBUTING.md` asks.

## Keeping Up With Upstream

Because there is no shared ancestry, tracking upstream is a review habit, not a merge.  Recommended: keep the `upstream` remote fetched; run this same review monthly (merged PRs since the last review date, the two-worktree diff, the three reviewer briefs); record every port in a ledger (`docs/upstream/PORTED.md`: upstream PR, BotFleet PR, date, notes) so a later reviewer can skip what landed; and re-check `LICENSING.md` and `enterprise/` on every pass, since the boundary moved once already.

## Structural Facts

BotFleet forked at about upstream v0.1.38 (Aug 31).  Since then upstream shipped 49 releases (v0.1.39 through v0.1.87) and merged 698 pull requests: 320 fixes, 197 features, 41 chores, 23 test changes, 8 CI changes, 4 perf changes, and 97 batch merges without a type prefix.  Weekly commit volume on upstream `main` ran 285 to 432 per week through mid-September and 676 in the week of Sep 21, most of it landed by the maintainer through "Integrate reviewed PR batch" merges that fold many contributor branches into one reviewed commit.  Four of every five contributor PRs come from a dozen people; the maintainer authored 328 of the 698.

Two structural facts shape what "borrowing" can mean:

1. **There is no common git ancestor.**  BotFleet's history was re-rooted on Sep 15 (its oldest commit is the PR #433 merge), so `git merge-base origin/main upstream/main` is empty and `git cherry-pick` cannot use ancestry.  Porting an upstream change means `git diff <before> <after> -- <paths> | git apply -3` where the touched files are still similar, or a manual re-implementation where they are not.
2. **The trees have diverged far.**  Per area, counting tracked files that are byte-identical, differing, only in BotFleet, or only upstream:

| Area | Identical | Differing | Only BotFleet | Only upstream |
|---|---|---|---|---|
| `server/` | 30 | 188 | 158 | 442 |
| `src/` | 33 | 143 | 121 | 406 |
| `electron/` | 13 | 56 | 33 | 77 |
| `ios/` | 31 | 69 | 73 | 104 |
| `companion/` | 7 | 21 | 3 | 8 |
| `shared/` | 0 | 5 | 14 | 51 |
| `scripts/` | 3 | 29 | 45 | 120 |
| `cloudflare/` | 16 | 14 | 1 | 0 |
| `.github/` | 2 | 5 | 4 | 11 |
| `docs/` | 35 | 21 | 108 | 231 |

Upstream-only top-level additions: `android/` (a companion app, 58,770 lines in one PR), `enterprise/`, `evals/`, `deploy/`, `Dockerfile` and `compose.yaml`, `CLA.md`, `LICENSING.md`, `maus.ps1`, and preview HTML for mascots and onboarding.  BotFleet-only: `tools/` (oxlint plugins) and `.vercelignore`.

3. **Upstream is now open-core.**  `LICENSING.md` keeps the project under Apache 2.0 with one carve-out: everything under `enterprise/` is source-available under the "OpenMausBot Enterprise License", which requires a license key to run in production and forbids hosting for third parties or white-labelling.  BotFleet must not borrow code from `enterprise/`, and any Apache-side file that imports from it has to be re-cut before porting.  The license map below records what falls on which side.

The biggest upstream PRs since the fork, by lines added: the Android companion (#513), eight-language localization across nine PRs (#891 through #915), "The bot is a folder: SOUL.md, self-setup by chat, bot settings dialog, mobile overview" (#833), two reviewed-batch merges (#1752, #1755), ten selectable mascot bodies (#663), a managed-computer inventory (#779), per-bot visibility fixes (#1720), and independent bot threads with a compact sidebar (#981).

## License Map

Verified by the infrastructure reviewer against `LICENSING.md`, `CLA.md`, `enterprise/LICENSE`, `enterprise/FEATURES`, and the open-core commits (`24fcea6c` PR #679 on Sep 2 created `enterprise/`; `6a378f4b` PR #965 added the licensing files):

- **Apache 2.0, free to borrow:** everything in both trees except upstream's `enterprise/`.  BotFleet forked before `enterprise/` existed and carries none of it.  No pre-existing Apache file was relicensed; the Apache relicense itself (PR #291) predates the fork, and both `NOTICE` files open with the same paragraph.
- **Enterprise-only, do not copy:** `enterprise/**` (Ed25519-signed `OMB_LICENSE_KEY` scheme in `enterprise/server/license.ts`, `issue-license.mjs`, the hosted-workspace sign-in adapter `server/workspace-access.ts`; entitlements `whitelabel`, `admin`, `budgets`, `billing`; `sso` planned).  Production use needs a per-organisation key; hosting for third parties or white-labelling needs a partner agreement.
- **The seam is one Apache file.**  Core reaches the enterprise layer only through `server/enterprise.ts`, a neutral never-throwing optional-plugin loader; `hosted-models.ts`, `brand.ts`, `spend.ts`, `cli.ts`, `index.ts`, and `hosted-slack.ts` import that file, nothing imports the folder, and a `foss` CI job deletes `enterprise/` and asserts `{"edition":"oss"}` on every run.  BotFleet may borrow the hook-point pattern freely.
- **Features that live behind the seam and are not for a single-owner fleet anyway:** organisation sign-in, organisation library, branding, license-expiry banners, spend caps, hosted-model routing (`server/enterprise.ts`, `server/brand.ts`, `src/lib/membership.ts`, `src/components/LicenseExpiryBanner.tsx`, `UsageBudget.tsx`, `WorkspacesSection.tsx`).
- **CLA and DCO:** no DCO; the CLA covers only contributions into `enterprise/` on the upstream repo.  Irrelevant to BotFleet unless it contributes upstream, which the fleet rule reserves for the owner's explicit approval.
- **NOTICE drift:** upstream's `NOTICE` gained paragraphs for Antigravity/T3 Code, hpke-js, and Simple Icons/Lobe Icons tied to `third_party/t3-code`, `third_party/hpke-js`, and `third_party/provider-icons`; none are vendored in BotFleet today.  Any port of those pieces must carry the matching notices.

## Product And Mobile UX: What To Borrow

Reviewer scope: upstream `src/**`, `ios/**`, `android/**` (scope only), and the docs BotFleet lacks, compared against BotFleet's renderer (`src/`, 65k lines) and iOS app (`ios/`, 29k lines).  Value is judged for a single owner running a fleet of bots on one Mac plus an iPhone.  Port cost reflects that the host files have diverged (for example `src/components/ChatMarkdown.tsx` is 419 lines in BotFleet and 939 upstream, each with 18 to 26 independent commits since the fork), so most items are re-implementations guided by upstream's code rather than patches.

| Candidate | Upstream | What it does | BotFleet status | Value | Cost |
|---|---|---|---|---|---|
| Digest chip and turn compaction | #1563; `src/components/DigestChip.tsx` (41 lines); iOS/Android hide-as-text fixes #1723, #1639 | A quiet chip under a turn ("12 tool calls · 4 files changed") with detail on hover | Missing (no digest concept) | M/H: fast skim across a busy fleet | S for the chip, M for the `message.digest` data model |
| Teammate-wait status | #1228; `src/components/SidebarBotActivity.tsx` (155 lines) | Sidebar says "waiting on X" instead of a generic busy spinner | Missing | M | S: isolated status computation plus a chip |
| Bounded reasoning window | `d8cba1b5`; `ios/Sources/CompanionCore/ReasoningWindow.swift` (34 lines) | Caps a long reasoning stream by character budget while keeping true step numbers | Missing (`ios/App/Cards/AgentThoughtChamberView.swift` has no counterpart) | M | S |
| Routine calendar preview | `src/components/routines/MiniMonth.tsx` (131 lines) | Small calendar confirming "first of every month" style schedules | Partial: BotFleet's `RoutinesPage.tsx` hides cron entirely; a preview layers on top | M | S |
| GFM tables and task lists on iOS | #1713; `ios/Sources/CompanionCore/Markdown.swift` 149 → 446 lines, `MarkdownTableTests.swift` | Real tables and checkbox lists in bot replies | Missing (no `.table` case in `MarkdownBlock`) | H: bots answer with tables constantly | M: self-contained parser and renderer |
| Mermaid diagrams in chat | #1619 (`f1e066fd`); `mermaid ^12` dependency | Renders ```mermaid``` fences as diagrams | Missing | H for an engineering fleet | M: about 200 lines plus a dependency, hand-merged into a diverged `ChatMarkdown.tsx` |
| Thread snooze, desktop and mobile | #1205, #1248; `src/components/SidebarThreadRow.tsx` (314 lines) and its expiry test | Snooze one conversation until activity or a time, not the whole bot | Missing: `server/routines.ts` ~439 only has bot-wide `snoozeBot` | H: quiet one thread without muting a bot | M: data field plus three surfaces |
| Command allowlist | #1754 (`4be2e469`); `server/command-allowlist.ts` (154 lines) plus driver hooks in `claude.ts`, `codex.ts`, `acp/core.ts` and composer/settings UI | A bot may only run commands on an exact allowlist, enforced server-side | Missing | M: a safety rail for Full-access bots | M |
| Per-bot connector tool grants | #1756 data model, #1761 relay enforcement (592 lines), #1804 tools/list filtering | Scopes which MCP tools a connected service exposes per bot | Missing | M: safety for a fleet with several connected services | M: mostly new files |
| Preset bots in New bot | #1773; `docs/presets.md` | Named starting points that fill a new bot's identity, skills, and notes | Missing (BotFleet's "presets" are UI skins) | H: spin up a specialist from a known-good template | L: the file-import path is Apache; the organisation-library path is enterprise-gated |
| Team package v2 and Share team | #1763, #1766; `src/components/ShareTeamDialog.tsx` | Whole-team export and import as one file with secret-redaction for connection addresses | Partial and diverged (`src/components/TeamLibraryPanel.tsx`, `server/team-library.ts` differ in content) | M: cross-machine backup and restore | L |
| Sidebar decomposition and compact density | #1612; `SidebarThreadRow.tsx`, `SidebarBotListItem.tsx`, `SidebarSectionHeader.tsx`, `Sidebar.simple-mode.test.ts` | Splits the sidebar monolith into row components and adds a quiet density | Missing as a mode; BotFleet's `Sidebar.tsx` is a 2,902-line monolith | M | L: restructure, not a patch |
| Active Threads panel with inline pin | #1290, #1640, #1690, pin provenance #1672 | A panel listing threads waiting on you | Different paradigm: BotFleet's `ThreadTabs.tsx` already puts active threads in a top tab bar | M | M if the panel style is wanted |
| Walkie hold-to-talk voice mode (iOS) | `Walkie.swift`, `WalkieAudio/Controller/View/VoiceSettings.swift`, `ElevenLabs.swift`, `AgentProfileVoiceState.swift` | Speak to a bot and hear its settled reply, with question cards read immediately | Missing entirely (no Call or Walkie files in `ios/`) | H: hands-free on the phone | L: a new subsystem |
| iOS Share Extension | `ios/ShareExtension/` (4 files) plus `AppShared/OpenMausShared{Configuration,ConnectionStore,Inbox,Keychain}.swift` | Share text, links, and images into a bot from Safari or Photos | Missing entirely | H: the natural iPhone-first workflow | L: new Xcode target, App Group, shared keychain and config layer (BotFleet already declares the App Group entitlement with no code behind it, audit IO27) |
| Voice notes server plumbing | #1759 audio attachment kind, #1760 `send_voice_note`, #1762 keep live turn | Bots send and receive voice-note audio as an attachment kind | Missing | M | S for the server side; the web and mobile bubbles are still open upstream |
| Localization framework | #626; `src/locales/en.json` (2,625 lines), eight overlays, `pnpm i18n:check` | Offline JSON-catalog i18n | Missing | L for an English-speaking owner | L |
| CUA permission failure and recovery | #1730 (458 lines) | Surfaces and helps recover macOS Screen Recording and Accessibility failures during computer use | Unclear: BotFleet has a large computer-use surface (`electron/cua.mjs`, `LocalVmRuntimeCard.tsx`, `LinuxLocalControl.tsx`) that was not diffed against this fix | M | M (unverified) |
| Rename populated teams; model choice for specialist bots | #1685, #1681 | Two settings-flow conveniences | Low-confidence gap (BotFleet may use other terms) | L/M | S each |

Upstream fixes worth a manual check in BotFleet: an edited message not appearing until the server round trip (#1387 versus BotFleet's optimistic path at `src/state/store.tsx` ~1620), the collapsed Dynamic Island shell painting on devices without an island (#1749 versus `ios/App/Island.swift` ~57), and the generic busy spinner that says nothing (#1228).

Design ideas worth adopting even where the code is not portable:

- **Tightening-only proposal cards** (#1785 umbrella, still open upstream): a bot may propose narrowing its own future permissions, never widening them, as a reviewable diff card with expiry.  A safe way for Full-access bots to self-restrict.
- **Chief of Staff Full-access passthrough with a visible reason line** (`docs/approval-levels.md`): delegated work from a Full-access Chief runs Full, and the delegated thread opens with an explicit line saying why.  Check whether `server/delegations.ts` already has the receipt half.
- **Zero-code custom engines with per-instance icons** (`docs/custom-engines.md`): any ACP-speaking CLI or OpenAI-compatible endpoint via `config.json`.  BotFleet hard-codes its named extra engines; the zero-code path lets the owner try a new harness the day it ships.
- **Name the exact missing macOS permission during onboarding** (#1704, open upstream) and in the chat error when a computer call fails.
- **Treat silent config validation failure as a defect class** (#1797, open upstream): a single bad field must not revert the whole file to defaults.  Check `server/config.ts` for the same behaviour.

Not verified: several PR and issue numbers in the coordinator's brief did not match the exported lists (for example #1635, #1245, #1246, #1638, #1725, #1796 to #1800, #1814, #1765, #1727, #1798, #1719, #1625); the reviewer substituted the nearest keyword match where one existed (#1563, #1290, #1640, #1690, #1323, #626, #1629) and omitted the rest.

## Infrastructure, Packaging, CI, And Companion: What To Borrow

Reviewer scope: `.github/**`, `scripts/**`, `electron/**`, `companion/**`, `cloudflare/**`, `Dockerfile`, `compose.yaml`, `deploy/**`, `evals/**`, `docs/verification`, `docs/requirements`, `docs/specs`, `third_party/**`.  The reviewer notes that inside the shared object database the bare ref `main` is BotFleet's main, so every upstream comparison was made against `upstream/main`.

| Candidate | Upstream | What it does | BotFleet status | Value | Cost | Addresses |
|---|---|---|---|---|---|---|
| Release completeness and recovery workflow | `.github/workflows/sync-published-release.yml` (190 lines, `6de9eba2`) | On every published release (and on manual dispatch by tag for recovery) downloads the canonical release, hard-asserts the complete required asset list (all three feed YAMLs, every platform artifact, blockmaps, checksums), then mirrors it | Missing: `release.yml` publishes once with no post-publish completeness check or recovery path | H | S to M: one workflow, can self-target BotFleet's own repo | Issue #285, audit UI4 (the hourly 404 loop) |
| Updater error classifier | `electron/update-errors.mjs` (36 lines) | Pure `updateErrorMessage(error)` mapping TLS, integrity, disk-full, permission, file-busy, missing-feed 404, and 5xx/network to distinct human messages | Missing: `electron/updater-coordinator.mjs` ~20 shows raw error text | M | S: drop-in pure function | UI4 (diagnostics) |
| Offline eval harness | `evals/**` (README, `types.ts`, five scenarios, mock provider, runners, scorers, reports) | Deterministic scripted-provider replay against a real harness server ("evaluate the harness, never the models"), pinning dispatch-supersede, routine deferral, and lazy computer claim semantics | Missing | H: hermetic regression tests for orchestration bugs | M: pattern ports cleanly, internals diverged | The orchestration bug class behind HS18 to HS20 |
| Verification recipe library | `docs/verification/**` (README plus 83 recipes); upstream `AGENTS.md` is seven lines pointing at it | Per-feature "how to prove this works in an isolated fixture" recipes that the agent contract is forced through | Missing; BotFleet's `AGENTS.md` is self-contained | M to H: makes "I tested it" mean one thing | S to M: seed with a handful | Process quality |
| Self-hosting stack | `Dockerfile`, `compose.yaml`, `deploy/**` (Caddyfile, podman, local), `server/cli.ts` (1,257 lines: setup, start, serve, pair, sessions, status, login, access, service, fleet), `docs/self-hosting.md` (936 lines), `docs/deploy-vps.md` (397 lines) | A headless deployment path (Docker, VPS, systemd service, `serve --tunnel`) decoupled from the Electron app; the same companion guardian is spawnable headlessly through `electron/managed-companion-guardian-main.mjs` | Entirely absent (`server/cli.ts` does not exist) | H: the structural fix for the sidecar dying with the desktop app | L: the largest item here | Audit IO21 |
| CI as parallel jobs with a synthetic gate and merge queue | `ci.yml` after PR #1395 ("main was red about 36 of the last 48 hours"): static → vitest in four shards on three OSes → packaged-server smoke, Windows CUA smoke, Electron smokes → `gate`; `merge_group` trigger | Splits one slow sequential job per OS into parallel jobs; the `gate` job satisfies fixed branch-ruleset check names without a settings change; the merge queue tests the real merge result | BotFleet still runs one sequential `test` job per OS | M | M: about 450 workflow lines | CI wall-clock and flakiness (not OP8) |
| HPKE phone-credential transport | `companion/src/phone-secret-key.ts` plus `third_party/hpke-js` | RFC 9180 secure pairing credential transport | Absent | M: hardening | M: needs client coordination and NOTICE lines | None named |
| Per-issue requirements and specs | `docs/requirements/issue-NNNN-requirements.md`, `docs/specs/*.md` | Lightweight write-ups before implementation | Absent | L to M | S | Process |
| Hardening PRs sized but not read | #1712 managed-HTTPS identity preservation, #1703 Windows helper console, #1730 macOS CUA permissions, #1772 VPS SSH recovery | | Unknown overlap | Unscored | S to review | Possibly IO21-adjacent |
| Tailscale CLI fixture test | `companion/test/tailscale-cli.test.ts` | Dedicated fixture | BotFleet references Tailscale across the companion but has no fixture test | L | S | Coverage |

Corrections to assumptions the brief carried:

- **Cua Driver 0.28.2 is not shipped upstream.**  `third_party/cua-driver/README.md` on `upstream/main` pins 0.19.3, the same as BotFleet; the `chore/cua-driver-0.28.2` branch has a zero-line diff for that directory and deletes unrelated trees, so it reads as stale.
- **Upstream has no APNs delivery.**  `server/notify.ts` and `ios/App/Notifications.swift` describe closed-app APNs as a future relay.  BotFleet's `companion/src/apns.ts` (1,824 lines plus a 2,209-line test) is capability upstream has not built, so the IO1 to IO6 fixes are BotFleet's own.
- **Upstream has no Sentry** anywhere in `server/` or `scripts/`; OP1 is BotFleet-only.
- **Upstream has no CI path filters at all** (`ci.yml` runs iOS, Android, and Linux packaging on every PR); BotFleet's `changes` job and `scripts/ci-change-scope.mjs` are ahead.  Upstream solved wall-clock with sharding, not scoping.  Upstream has no scheduled TestFlight workflow either; its iOS and Android jobs only do unsigned debug builds.
- **The sidecar coupling is deliberate in both trees** (`electron/managed-companion-guardian.mjs`: a parent-death guardian that kills cloudflared and only then releases port 8812 so no exposed port is orphaned).  What upstream has that BotFleet lacks is the headless entry point, which only exists because of the standalone CLI and self-hosting stack.

Process ideas: prove the feed after every publish with a manual recovery path; evals as hermetic orchestration regressions; a verification-recipe library the agent contract points at; parallel CI jobs behind one synthetic gate plus a merge queue; a one-page requirements note before each hard issue.

## Server Runtime And Drivers: What To Borrow

Reviewer scope: upstream `server/**`, `shared/**`, `skills/**`, `evals/**` against BotFleet's harness and drivers.  The enterprise boundary touches none of these candidates.  Driver files have diverged past patch application (`claude.ts` 1,295 versus 2,123 lines, `codex.ts` 749 versus 1,728, `acp/core.ts` 1,125 versus 1,771), so ports are manual; the pure modules listed as "S" drop in whole.

| # | Upstream | What it does | BotFleet status | Value | Cost | Audit finding |
|---|---|---|---|---|---|---|
| A | #774 `server/chief-of-staff.ts:16` | Drops live busy state from the Chief roster text; `list_bots` is the authority for availability | Missing: `server/chief-of-staff.ts:55` still emits "working right now" / "available" | H | S: two lines and a test | DR1 |
| A2 | BotFleet-specific, found while verifying A | `botFleetStatusSystemPrompt()` splices `observed_at=<timestamp>` and `ready_count` into the same Chief system string every turn | `server/botfleet-status-capsule.ts:349-360` | H | S | DR1 (second root cause) |
| B | #1758, #1031: `server/drivers/prompt-split.ts` (122 lines), `server/system-prompt.ts:19-49`, `contracts.ts:131-147` | Splits the system prompt into a byte-stable half and a volatile half (memory, mentions, outstanding, recent); the volatile half is delivered inside the turn that changed it, with a receipt committed only after the provider accepts | Missing entirely: BotFleet concatenates one string at `server/index.ts:3493-3529`; no section model | H: it is the whole of DR1 plus the cached-input story | M to L: the module is small, the `PromptPart[]` builder BotFleet lacks is the work | DR1, enables C to E |
| C | #1757, #1758 Codex half: `server/drivers/codex.ts:1423-1541`, `codex-instructions.ts` | Only the stable half goes in Codex's developer slot; a receipt tracks which volatile digest the native thread carries | Missing: `server/drivers/codex.ts:609` prepends the entire system prompt to every turn's input | H: every Codex turn re-uploads the whole prompt uncached | M | DR1, DR3 |
| D | #1758 ACP half: `server/drivers/acp/core.ts:1588-1638` | Full prompt only on the turn that establishes the native session | Missing: `server/drivers/acp/core.ts:976-978` prepends the full system prompt every turn on nine ACP engines | H | M | DR1, DR3 |
| E | #1758 HTTP half: `server/drivers/openai-chat.ts:317-339` | System message carries only the stable half; volatile rides the newest user message | Missing three times: `grok.ts:201`, `minimax.ts:516`, `openai-compat.ts:397` each send `turn.system` whole | H: cached-input pricing on OpenRouter, DeepSeek, and MiniMax turns on prefix stability | S once B lands | DR1 |
| F | #1705 `server/resume-recovery.ts` (84 pure lines) | Classifies a failed resume as before-accept, after-accept, or unknown from protocol state, never error text; only before-accept may be replayed | Missing | H: the principled core of HS18 | S to port, M to wire | HS18 |
| G | #1280 `server/thread-retention.ts` (about 60 lines) | Daily sweep deleting `events/` and `native/` logs for threads past a retention window, never touching busy, unread, or open-handoff threads | Missing: BotFleet only caps live files | H | S | HS1 |
| H | #1756, #1761 `server/connector-verdict.ts` (171 lines) | Per-bot Composio tool grants enforced harness-side on the MCP relay, including the multi-execute meta-tool, deny by default on unrecognised argument shapes | Missing: `server/connector-proxy.ts:175` forwards every `tools/call` with no grant check | H: any bot with Composio can act as the owner across every connected service | S to M: one pure module, one call site, a `connectorTools` field | New security finding |
| I | #1754 `shared/command-allowlist.ts`, `server/drivers/permission-command.ts` | Exact-command allowlist keyed on command, cwd, and provider instance, with "remember this command" on the approval card | Partial: `server/auto-approve.ts:73` has a heuristic key only | M | M (UI is the bulk) | |
| J | #1596 `server/drivers/acp/core.ts:326-331` | Replaces the wall-clock `session/prompt` deadline with a renewable idle deadline (180 s of silence) | Missing: `acp/core.ts:274`, `:985` use an 18-minute wall clock that both kills long runs and lets a wedged turn burn 18 minutes | M to H | S | Adjacent to DR3 |
| K | #1678 `canAdmitDirectTurn(botId, threadId)` | Admission tests thread slot plus no live group turn, not whole-bot idleness; every deferred path re-tests it | Missing: about 25 `bot.busy` checks in `server/index.ts` | M today, higher with multi-thread bots | L: depends on upstream's multi-thread store | |
| L | #585, #1128, #566 delegation ledger | A handoff to a busy peer queues a durable 24-hour receipt instead of dead-ending | Missing: `server/delegations.ts:253-259` cancels with "@X is busy" | H when the Chief fans out | M: needs a durable ledger | Adjacent to DR9 |
| M | `server/message-db.ts:296-341`, `steer-queue.ts:70-79`, `channel-queue.ts:34-40` | Steer and channel queues persist as `chat_followups` rows restored on boot, with sender, trigger, unattended, and peer-ask provenance | Missing: BotFleet's `steer-queue.ts` says "memory-only; restart loses the queue" | M to H with 29 boots in two days | M | HS18-adjacent |
| N | #1717, #1720 `server/admin-activity.ts` | Append-only activity log for a shared workspace | Missing | L for a single owner | M | |
| O | #1507 `evals/` | Offline tier-1 behaviour evals with a scripted deterministic engine | Missing | M: would have caught DR1 and the delegation dead-end | L | |
| P | #1709 `server/usage-ledger.ts:40`, `:88`, `:115` | Books stable versus volatile prompt bytes beside each turn's usage | Missing | M: the measurement that proves the split works | S once B lands | DR1 verification |
| Q | `shared/redact.ts:24-27` | Adds `xai-`, `gsk_`, `hf_` key prefixes | Partial: `shared/redact.ts:49-62` lacks all three, and BotFleet ships a Grok engine | M: a pasted `xai-` key is not masked today | S | New finding |
| R | `server/message-db.ts:368-380` `readThreadTail` | `LIMIT`-ed SQL tail read used by the store | Missing: BotFleet materializes whole threads | M | S | HS12 (the paging half) |

Where BotFleet is ahead (do not port backwards): `shared/redact.ts` is 1,064 lines versus 66 upstream and handles truncated secrets, placeholder text, and unterminated auth headers; `harness/bus.ts:44-59` has a duplicate-terminal-event detector upstream lacks; BotFleet derives `replaysNatively` from `capabilities.replaysTranscript` (`server/index.ts:3124`) where upstream still hardcodes a driver list; `bots.json` already goes through `writeFileAtomic`.

Shared defects upstream has not fixed either: HS10 (`OMB: server/harness/bus.ts:48` still redacts synchronously before a synchronous append), HS2 (no `VACUUM`), HS12 (unbounded `Store.threads`, though the paged reader R is the SQL half), and open issue #1686 (the skills index silently drops enabled skills past `INDEX_MAX_BYTES = 4_000` on an alphabetical break), which BotFleet has verbatim at `server/skills.ts:39` and `:296`.

Upstream also fixed, and BotFleet still has: `routines.json` written through a fixed temp path with no fsync (`server/routines.ts:1309-1327`; upstream uses `writeFileAtomic` at `routines.ts:1944` and `webhooks.ts:600`), and `setActivity` saving the whole roster (upstream keeps activity in memory and strips `busy` and `activity` from the persisted shape at `store.ts:949`, `:1987-1995`).

Design ideas worth adopting:

- **Stable prefix, volatile note.**  The boundary is a property of the section, not the driver; only the stable half may enter a spawn fingerprint, a developer slot, or a system message; the volatile half is delivered inside the user turn as a labelled block only when its digest changed, a mention forces delivery even when byte-identical, and the receipt commits only after the provider accepts.  Upstream exempts pi because it compacts by summarising user messages, a warning for any engine that rewrites its own history.
- **Admission as one named predicate** called by every deferred path (routines, webhooks, team-setup resumes, delegation handoffs, room drains) so two paths can never disagree about whether a bot can take work.
- **Bounded delegation with a durable ledger**, keeping the asymmetry that a bot's own fan-out is discardable on Stop while a person's queued words are never dropped.
- **Replay safety from protocol state, never error text** (resume-recovery's own header).
- **Grants enforced where identity lives**: on the harness side of the relay, where the loopback token already names the bot and the decision log is native; deny unrecognised shapes by default.  The rule generalises to BotFleet's `connector-proxy.ts`, `qdrant-proxy.ts`, and `computer-proxy.ts`.

## Method And Limits

Three read-only workers compared the trees at the stated commits; no code was executed.  PR and issue numbers in the coordinator's briefs that did not match the exported lists were dropped or replaced by the nearest keyword match, as noted in each section.  Not read in depth: `electron/main.mjs` (3,121 upstream lines versus 2,416), the isolated diffs of #1712, #1703, #1730, and #1772, the voice-note pipeline, the Mistral and MiniMax drivers, and the Android app beyond its layout.  Worker reports are in this session's transcript; this document keeps only what was verified.
