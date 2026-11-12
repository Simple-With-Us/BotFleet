---
name: closeout
description: Finish a Monet work unit — THE BOARD, effort log, GitHub issue, Slack, Apple Notes, PR merge state, and Mac-process inventory. Use when a lane is merged, deployed, parked, or handed off. Never silently walk away from In Progress.
---

# Closeout (MONET)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Start-of-work is a triple claim.  End-of-work is the same three surfaces plus Notes when the owner might ask "what happened?"

## 1. Truth check

- Merged to `main`?  (`gh pr view` / `git merge-base --is-ancestor`)
- Production verified?  (`deploy-verify`)  Completed ≠ Deployed.
- Uncommitted files?  Commit or explicitly report why not (failing tests, secrets, owner hold).

## 2. THE BOARD

```bash
board status <id> completed --resolution "Landed in #<PR>.  <one line>."
# or: deployed — only after health verify
```

If the item is an `effort-row` / `github-issue`, writeback copies that status to the live effort log and GitHub within ~10 min.  Still land `docs/EFFORT-LOG.md` in the app PR.  A comment is useful context; the 15-min grace window keeps sync from clobbering the status you just set.

## 3. Effort board + issues

Live board first, then `docs/EFFORT-LOG.md` in the landing commit.

- **Completed** = merged to main.
- **Deployed** = released and verified (say how).
- Never delete another row.  Correct in place with `(Monet): …` and the date.

Board and GitHub issues must match.  Prefer landing the mirror so `effort-issues-sync` closes the issue.  If you executed a numbered issue, comment/close it so it is not abandoned.

Cross-app work gets a row on each affected board.

## 4. Slack

```bash
AGENT_TAG="${AGENT_SEAT:?set MONET, CLAUDE, or RENOIR}" /Users/jay/apps/ag***-s**c-websocket.py --post "[$AGENT_SEAT] sync-N
repo: <project>
state: DONE
pr: #<n>
board: <id>
work: <what landed>"
```

Not `FLEET` for a normal closeout.

## 5. Apple Notes

Substantial work: living Completion note, `--update` in place.  Title `[APP, Monet] short topic`.  See `apple-notes`.  Cloud sessions: skip Notes, say so, leave the handoff in the PR.

## 6. Mac local processes

If this unit created, loaded, bootout, or retired a LaunchAgent, cron, login item, pm2 KeepAlive job, **or a helper other agents run**: add/update a row on `/Users/jay/apps/MAC-LOCAL-PROCESSES.md` **and** `--update "⭐️ Background Jobs Master List"` in the same change.  Say always-on vs on-demand.  Retire in place; never delete historical rows.

Do not SIGKILL `com.jay.claude-remote-control`.

## 7. Default-off features

If you shipped a flag that is off, reserve a Planned enablement row (ST: also `docs/FEATURE-ENABLEMENT-BACKLOG.md`).

## Parked, not done

If you stop without merge: board stays accurate (`open` or a comment "parked because …"), Slack says BLOCKED/parked, worktree is not dirty with uncommitted finished code.  In Progress after you left is how three agents redo the same slice.

## Canon

- `/Users/jay/apps/AG***-S**C.md` — triple closeout; Apple Notes; Mac local processes; always-commit
- `/Users/jay/apps/EFFORT-LOG-PROTOCOL.md`
- Skills: `board-ops`, `apple-notes`, `deploy-verify`, `land-lane`

## Living Handoff Morphing to Closeout

Throughout execution, maintain a brief big-picture outline of task state. When the task is complete, this outline naturally becomes your **Closeout Report** by:
1. Marking all milestones as completed with commit/PR references.
2. Replacing in-flight WIP notes with live production deployment verification (`/api/health` 200, build SHA).
3. If closing out work adopted from a peer, posting a direct `[<SUB_TAG>-><ORIGINAL_TAG>]` Slack notification to `#ag***-s**c`.
