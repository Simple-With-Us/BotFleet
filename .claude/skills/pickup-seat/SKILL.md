---
name: pickup-seat
description: >-
  Pick up a capped-out or abandoned peer seat's in-flight work (owner-directed only). Inventory Linear (THE BOARD), PRs, dirty worktrees, and Zulip; claim; adopt uncommitted work with authorship credit; disposition each item; hand back. Use when the owner says a seat hit a usage cap, died mid-task, or "take over X's lanes."
---

# Pick up a seat (MONET)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Owner-directed only.  Do not initiate a raid on a live peer.

You are **$AGENT_SEAT** (MONET, CLAUDE, or RENOIR).  Keep that seat's prefix.  If you continue a peer's `claude/` or `grok/` branch, say so on Slack and do not rebrand their prefix as yours unless you are opening a new follow-up branch.

## INVENTORY

```bash
board list --status in_progress --limit 50
board list --mine <THEIR_TAG> --status open,in_progress

gh pr list --state open --json number,title,author,mergeStateStatus,autoMergeRequest,url

git worktree list
# then git status in each dirty tree you might adopt

git for-each-ref --sort=-committerdate refs/remotes/origin --format='%(committerdate:short) %(refname:short) %(authorname)' | head -30

AGENT_TAG="${AGENT_SEAT:?set MONET, CLAUDE, or RENOIR}" /usr/bin/python3 /Users/jay/apps/agent-sync-poll.py
```

Also read their last Slack claim and any living Apple Note titled `[APP, <Seat>] …`.

## CLAIM

Post repo-first, naming exactly what you are taking:

```bash
AGENT_TAG="${AGENT_SEAT:?set MONET, CLAUDE, or RENOIR}" /Users/jay/apps/agent-sync-websocket.py --post "[MONET-><SEAT>] sync-1
repo: <project>
claim: picking up <SEAT> cap — effort + PR #<n>
state: WIP
do-not: double-work these lanes"
```

Put the same claim on Linear (`board claim` or `board comment` on the issue id).

If they used `FLEET` incorrectly, do not echo it.  Directed `<SEAT>` is enough.

## ADOPT uncommitted work

Never `reset --hard` / checkout over dirty files.

```bash
git add <files>
git commit -m "Uncommitted work from capped <SEAT> session.

Landed as continuation during cap handoff; authorship credit retained.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Match the trailer already in history **per tool**, not a fabricated seat email.  Monet and Claude Code both use `Claude <noreply@anthropic.com>`.  Codex/Grok/Cursor trailers stay those tools' trailers.

Confirm no new commits or Slack posts from that seat since the cap before you overwrite their narrative.

## DISPOSITION

| State | Action |
|-------|--------|
| Already merged | `git log origin/main`; board row Deployed if prod verified, else Completed |
| Armed + green | babysit; `unstick-pr` if it stalls |
| Committed, not landed | `land-lane` |
| Uncommitted, finished | commit with credit; land or hold |
| Uncommitted, unfinished | complete only if owner-directed; else note and park |
| Claimed, not started | release; Slack + board |
| Genuinely blocked | board comment with reason; escalate P0 |

Do not kill `com.jay.claude-remote-control` while hunting "stuck Claude."  Monet/Renoir/Claude all look like `claude` in `ps`.

## HAND BACK

Answer disambiguation pings fast.  Cede lanes the returning seat re-claims, especially their authored deltas.  Report SHAs, PR numbers, board ids, what is ready to merge.

## CLOSE OUT

`closeout` skill: Linear resolution, `docs/rollouts/YYYY-MM-DD-pickup-<seat>-cap.md`, Apple Note `[APP, Monet] pickup <seat> cap`, Zulip summary.  Correct premature claims in place.

## Canon

- `/Users/jay/apps/AGENT-SYNC.md` — handoff, seats, Mac local processes
- `docs/launch-identity.md` § Linear Board Access
- Skills: `session-start`, `board-ops`, `land-lane`, `unstick-pr`, `closeout`

## Substitute Agent Direct Slack Closeout `[SUB->ORIGINAL]`

Once you finish taking over a peer agent's work (or reach a clean handoff point):
1. **Send Direct Slack Message:** Post directly to `#agent-sync` addressed to the original agent:
   ```text
   [<YOUR_TAG>-><ORIGINAL_TAG>]
   repo: <repo>
   task: <Feature / PR #<num>>
   status: Completed & Deployed
   notes: <Summary of what was completed, any bugs fixed, or caveats for the original agent to review>
   ```
2. **Update Apple Note:** Add a completion section to the original handoff note or publish the final closeout note referencing the adopted branch.
