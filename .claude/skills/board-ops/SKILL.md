---
name: board-ops
description: Use THE BOARD (mac.jays.services/board + the board CLI) as the first place to look and write. File, claim, comment, and resolve fleet items. Trigger whenever starting work, hunting open P0/P1s, reviewing a peer fix, closing a lane, or when the owner mentions the board, mac-collab, or findings.
---

# THE BOARD (MONET)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Primary coordination surface (owner 2026-08-19).  One searchable board over review findings, every app's effort-board rows, and every repo's GitHub issues, synced about every 10 minutes.

Humans: `https://mac.jays.services/board` (HTTP Basic Auth, any username, password = `$MAC_COLLAB_TOKEN`).  Short link `https://board.jays.services` 302s there.  Agents: the `board` CLI.

## Invoke it literally

```bash
board stats
board list --status open,in_progress --severity P0,P1
board list --app congress-trade --mine "$AGENT_SEAT"
board show <id>
```

`~/apps/mac-collab/board`, also `~/.local/bin/board`.  It reads `MAC_COLLAB_TOKEN` from `~/.secrets/mac-collab.env`.  The token must never appear on a command line, in `ps`, or in a transcript.

Claude Code only offers "Always Allow" when the command has a stable prefix.  `board stats` allowlists.  `B=…/board; $B stats`, `$(…)`, pipes, and `&&` chains do not.

`--env` is only `Mac` or `cloud`.  `--by` for this seat is `MONET`.

## File / claim / talk / finish

```bash
board file --title "Scout drops Senate rows on 502" --app congress-trade \
  --severity P1 --by "$AGENT_SEAT" --env Mac --where "~/apps/congress-monet @ monet/fix" \
  --desc "path:line + repro"

board claim <id> --by "$AGENT_SEAT" --env Mac --where "~/apps/congress-monet @ monet/fix"

board comment <id> --by "$AGENT_SEAT" --text "Verified on main; the shared helper is right."

board status <id> completed --resolution "Landed in #2894."
```

`--app` values you will actually use: `socratic-trade` / `Socratic.Trade`, `congress-trade`, `usage-monitor`, `congress-trading-shared`, `dealdex`, `personal-site`, `fleet-infra`.  If unsure, `board stats` prints the live app list.

Status values: `open`, `in_progress`, `completed`, `deployed`, `addressed`, `wontfix`, `duplicate`.

## What you owe the board

1. **Before substantial work:** list the app.  Claim the existing item or file then claim.
2. **While working:** keep `--by "$AGENT_SEAT"`, `--env Mac`, and `--where "worktree @ branch"` accurate.
3. **When done:** `completed` or `deployed` with a resolution that names the PR and what changed.  Do not leave `in_progress` after you stopped.
4. **On a peer's item:** comment with evidence.  Reviewing fixes here is expected.

## Item kinds

- `agent-report` (default) and `review-finding` — your status persists.
- `effort-row` and `github-issue` — mirrored both ways.  `mac-collab-writeback` (pm2, 10 min) moves the live effort-log bullet and closes/reopens the GitHub issue to match a status you set on the board.  A 15-minute grace window stops `mac-collab-sync` from overwriting that status.  Still land `docs/EFFORT-LOG.md` in the app PR when you are in that repo; writeback does not push git.

The board is the **write surface**.  Live `~/apps/*-EFFORT-LOG.md` and GitHub Issues are copies for seats that cannot reach the board.

## Do not

- Paste `MAC_COLLAB_TOKEN` into curl "to be safe."  Use `board`.
- Use THE BOARD as the only closeout.  Slack + effort board + issues still move.
- File a duplicate because you did not `board list --search` first.

## Canon

- `/Users/jay/apps/AG***-S**C.md` § THE BOARD
- `/Users/jay/apps/EFFORT-LOG-PROTOCOL.md`
- `board --help` / `board file --help`
