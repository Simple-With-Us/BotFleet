---
name: apple-notes
description: >-
  Write owner-facing Apple Notes in the `Coding` folder (local on this Mac) — plans, designs, reviews, handoffs, rollouts, living Completion notes. Use whenever Monet produces something the owner needs to read, not only when they say "Notes." Title [APP, Monet] … with a refreshed timestamp.
---

# Apple Notes (MONET)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Mac only.  Cloud sessions: skip Notes, say so, leave the handoff in the PR.

Notes.app does not render raw Markdown.  The helper converts MD → HTML.  Pass `--html` only when you already have Notes-safe HTML.

## Helper

```bash
/Users/jay/apps/apple-notes-coding.sh "Title" "plain body"
/Users/jay/apps/apple-notes-coding.sh "Title" --html /path/to/body.html
/Users/jay/apps/apple-notes-coding.sh --update "Title" "body"
/Users/jay/apps/apple-notes-coding.sh --update "Title" --html /path/to/body.html
/Users/jay/apps/apple-notes-coding.sh --pin-only "Exact Title"
/Users/jay/apps/apple-notes-coding.sh --unpin-only "Exact Title"
```

Also: `--notify` / `--pushover`, `--needs-owner` / `--action-required`, `--summary "one sentence"`, `--pr "18"`.

Default is headless pin via the `Pin Coding Note` shortcut (no focus steal).  Do not `APPLE_NOTES_ACTIVATE=1` unless the owner is sitting at the Mac.

## Title

```
[APP, Monet] short topic
```

- Acronyms first, then `Monet` (Title Case, not all-caps Slack tags).
- Multi-app: `[ST, CT, Monet] …` (impact order).
- No date in the title.  No word "session".  Do not repeat the title as an H1 in the body.

| Acronym | App |
|---------|-----|
| UM | Usage-Monitor |
| ST | Socratic.Trade |
| CT | Congress.Trade |
| CTS | congress-trading-shared |
| DD | DealDex |
| PS | Personal-Site |
| AFL | ai-fleet-coordinator (this repo / Mac collab / skill pack) |
| OPS | fleet-ops (sibling identity; do not invent a checkout here) |

## Second body row

The helper injects/refreshes:

```
Sun, Aug 9, 3:52pm · PR #18
```

Local Mac time, no leading zeros, lowercase am/pm.  Refresh on every `--update`.

Then: type line (`Completion` / `Plan` / `Review` / `Design` / `Handoff` / `Rollout` / `Incident` / `Fleet change` / `Work log`), then content.

Order: `Needs owner` first when applicable, then Problem → What was done → Decisions → Next steps.

A real U+00A0 plus a normal space between sentences in the body file you pass the helper (owner ruling 2026-10-23).  Never write the `&nbsp;` entity yourself.

## Layout (owner 2026-08-21 — binding)

Notes.app collapses adjacent blocks.  A wall of text with no air is a bug.  The owner reads these on iPhone.

Prefer `--html` for anything longer than a few lines.  In that HTML:

- `<h2>` never `<h1>` (the helper already wraps the title as `h1`)
- After the type line: `<div><br></div>`
- After every heading: `<div><br></div>`
- After every paragraph: `<div><br></div>`
- Between every bullet in the same list: `<div><br></div>`
- After a list, before the next heading: `<div><br></div>`

Do not pass a packed markdown blob.  If you use the plain-body MD path, put a blank line between every section and every bullet — the helper turns those blanks (and consecutive list items) into spacers.  `--html` with explicit spacers is still the owner-readable path.

## When

Do Notes: plans, design docs, reviews, handoffs, rollouts, **Completion / work-complete** for anything the owner might ask about.

Skip: pure `#agent-sync` chatter, effort-board row edits, routine commit messages, peer-only PR nits.

Open a living work note when substantial work starts.  Always Completion at the end.  Update in place; unpin stale Completion notes when the lane closes (`--unpin-only`).

Background-jobs inventory note is `⭐️ Background Jobs Master List` — refresh that title exactly when `MAC-LOCAL-PROCESSES.md` changes.

## Canon

- `/Users/jay/apps/AGENT-SYNC.md` § Apple Notes
- Skills: `closeout`, `owner-copy`

### Handoff Reports (Immediate & Living)
When generating a handoff report for a peer agent to take over (e.g. before hitting quota or upon owner stop request):
- **Title Format:** `⭐️ [APP, Agent] HANDOFF REPORT: Short topic` (or `*** [APP, Agent] HANDOFF REPORT: Short topic`)
- **6-Section Body:**
  1. Executive Summary & Objective
  2. Current Work State & Artifacts (worktree path, branch, commit SHA, PR status, dirty/stashed files)
  3. What Was Completed
  4. What Remains to Be Done (actionable numbered list for substitute agent)
  5. Gotchas, Blockers & Open Decisions
  6. Reproduction & Verification Commands
