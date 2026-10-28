---
name: unstick-pr
description: Diagnose and repair a PR that will not merge — phantom vs real conflicts, unresolved review threads, CI dispatch misses, required-check failures, and known flakes. Use when mergeable is false, auto-merge sits idle, GitHub says CONFLICTING/BLOCKED/DIRTY, or a Monet/peer PR is green but stuck.
---

# Unstick a blocked PR (MONET)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Zulip or `simple-board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Works in every fleet repo.  Substitute owner/repo from `gh repo view --json nameWithOwner`.

## 1. Snapshot

```bash
gh pr view <N> --json state,mergeable,mergeStateStatus,autoMergeRequest,statusCheckRollup,url
```

Note `mergeable` and `mergeStateStatus`.  Continue if OPEN and not cleanly mergeable, or if auto-merge is null.

## 2. Classify

### A) CONFLICTING or DIRTY

Distinguish phantom vs real with the **2-argument** `git merge-tree`.  The old 3-argument form always exits 0.

```bash
git fetch origin
git merge-tree --write-tree origin/main origin/<branch>
```

- Exit 0 = **PHANTOM**.  GitHub's mergeability cache stuck (common under concurrent push bursts).
- Exit 1 with conflict markers = **REAL**.

**Phantom fix:** merge `origin/main` in the Monet worktree and push a fresh head SHA.

```bash
cd ~/apps/<prefix>-monet   # never ~/Code/<repo>
git fetch origin
git merge origin/main --no-edit
git push origin <monet|claude|renoir>/<slug>
```

GitHub recomputes in ~20–60s and re-dispatches CI.  If several PRs are stuck, push one at a time, ~10–15s apart.

**Real conflict:** merge `origin/main` by hand in the worktree.  `STATUS.md`, `PLAN.md`, and `docs/EFFORT-LOG.md` often have `merge=union` — additive board prose combines.  Never delete another agent's row.  If code intent is unclear, abort and escalate on THE BOARD + `#Work-In-Progress`.

### B) BLOCKED, checks green

Unresolved review threads.  Branch protection requires conversation resolution (`enforce_admins: true`).  Use `codex-triage` (all review bots, not only Codex).  Re-check `gh pr view` after.

### C) Required check FAILURE

Do not guess.  Open the failing job.

- First-time flake on a known-flaky e2e job: `gh run rerun <run-id> --failed` **once**.  A second identical failure is real.
- ST Playwright `smoke` (`test/e2e/dashboard-smoke.spec.ts`) has a documented flake class: `docs/rollouts/2026-06-22-e2e-smoke-auth-fix.md`.
- Money-path / typecheck / gitleaks failures are real until proven otherwise.

CI runs on Coolify self-hosted runners (`congress-ci` / `socratic-ci` / `hetzner-ci` labels).  Do not start or "fix" a local Mac Actions runner — permanently banned for PR checks.  iOS ship is GitHub-hosted `macos-latest` only (Compiler / `GB-COMPILER`).  DealDex's hosted Actions ship stays — do not disable it.  Do not compile or upload from this Mac, and do not force a ship past the gate.

### D) No CI on this head SHA

Same class as phantom.  Push a fresh head as in A.

## 3. Re-arm auto-merge

```bash
gh pr merge <N> --squash --auto
gh pr view <N> --json autoMergeRequest
```

`autoMergeRequest` must be an object, not `null`.  Not `--admin`.

## 4. If it still hangs

Repeat 1–3.  Comment on the matching board item.  Do not force-merge, do not disable protection, do not resolve threads without a reply.

## Canon

- `/Users/jay/apps/FLEET-PROTOCOL.md` — Merge requirements; CI runner policy
- App `AGENTS.md` Pull requests section
- Skills: `codex-triage`, `land-lane`
- ST flake origin: `docs/rollouts/2026-06-22-e2e-smoke-auth-fix.md`
