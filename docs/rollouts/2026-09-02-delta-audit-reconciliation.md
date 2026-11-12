# Rollout — Delta Audit reconciliation, main repair, fixer wave

**Why:** Owner asked for a top-to-bottom analysis and then for the P0/P1 concerns to be handled.  Main had gone red overnight.

**What:** `docs/audits/2026-09-02-delta-audit-reconciliation.md` (concur/dispute on every Delta Audit claim, new findings, revised batches), a fleet-compliant `AGENTS.md` (seat-agnostic tags, THE BOARD CLI, effort logs, Apple Notes, copy rules, Mac processes, iOS loop, verification gate), and the effort-log mirror.  Code changes are in their own PRs: #130 (main repair) and the wave branches `claude/harness-ops`, `claude/automation-runs`, `claude/site-truth`, `claude/off-fleet-defaults`, `claude/trust-boundaries`, `claude/computer-tests`.

**Verified:** docs only in this PR.  Facts in § 18 were checked by hand on Sep 1-2 (launchctl, lsof, curl, GitHub API, Vercel CLI).

**Landed (Sep 2, evening):** #130, #140, #132, #133, #141, #137, #143, #138, #139, #142, #136 — all merged; `main` green on every CI job.  **Owner actions:** upload `latest-mac.yml` + zips to v0.1.38 on the BotFleet repo's own Releases (PR #146 consolidated the feed there; `botfleet-releases` is retired, deletion owner-only); deploy a fleet-owned Composio broker and control plane; re-auth `gh` on the Mac; run `~/apps/update-botfleet.sh` so the installed app picks up #137.
