---
name: board-ops
description: Use Linear (via the board CLI or agent-sync linear_* tools) as the first place to look and write.  File, claim, comment, and resolve fleet items.  Trigger whenever starting work, hunting open P0/P1s, reviewing a peer fix, closing a lane, or when the owner mentions the board, Linear, or findings.
---

# Board CLI On Linear (MONET)

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Zulip or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


Linear (`https://linear.app/simple-with-us`, one team per app, issue ids like `BF-123`) is the system of record.  The `board` CLI is Linear-backed and must resolve to `~/.local/bin/board`.

**Never prepend `~/apps/mac-collab` to `PATH`.**  That directory holds a legacy binary with the same name; it shadows Linear and sends writes to the retired mac-collab tracker.  Run `command -v board` before trusting a list.  Humans may use the Linear web UI; `https://mac.jays.services/board` is a read-only archive until about day 30 after cutover.

## Invoke it literally

```bash
command -v board   # expect ~/.local/bin/board
board stats
board list --status open,in_progress --severity P0,P1
board list --app botfleet --mine "$AGENT_SEAT"
board show <id>
```

`<id>` is a Linear identifier (`BF-123`), a full legacy board id, or the first eight or more hex characters of a legacy board id.  Every output line ends with the identifier — use it from then on.

The CLI loads credentials itself (the Fleet app credentials from Infisical Fleet-OPS via `fleet-secrets`).  The secret must never appear on a command line, in `ps`, or in a transcript.  Do not use a personal Linear connector or Composio to write: they act as Jay, not as a seat.

When the agent-sync MCP mounts Linear tools, `linear_list`, `linear_show`, `linear_claim`, `linear_comment`, `linear_file`, and `linear_status` are equivalent read/write surfaces for the same Fleet app identity.

Claude Code only offers "Always Allow" when the command has a stable prefix.  `board stats` allowlists.  `B=…/board; $B stats`, `$(…)`, pipes, and `&&` chains do not.

**Writes need `AGENT_SEAT`.**  `file`, `claim`, `status` and `comment` exit without a seat; `--by` must equal it.  `--env` is only `Mac` or `cloud`.

## File / claim / talk / finish

```bash
board file --title "Scout drops Senate rows on 502" --app congress-trade \
  --severity P1 --by "$AGENT_SEAT" --env Mac --where "~/apps/congress-monet @ monet/fix" \
  --desc "path:line + repro"

board claim <id> --by "$AGENT_SEAT" --env Mac --where "~/apps/congress-monet @ monet/fix"

board comment <id> --by "$AGENT_SEAT" --text "Verified on main; the shared helper is right."

board status <id> completed --resolution "Landed in #2894."
```

`--app` values you will actually use: `botfleet` / `BotFleet`, `socratic-trade` / `Socratic.Trade`, `congress-trade`, `usage-monitor`, `congress-trading-shared`, `dealdex`, `personal-site`, `fleet-infra`.  If unsure, `board stats` prints the live app list.

Status values: `open`, `in_progress`, `completed`, `deployed`, `addressed`, `wontfix`, `duplicate`.

## What you owe the board

1. **Before substantial work:** list the app.  Claim the existing item or file then claim.
2. **While working:** keep `--by "$AGENT_SEAT"`, `--env Mac`, and `--where "worktree @ branch"` accurate.
3. **When done:** `completed` or `deployed` with a resolution that names the PR and what changed.  Do not leave `in_progress` after you stopped.
4. **On a peer's item:** comment with evidence.  Reviewing fixes here is expected.

## Effort logs

Effort logs are archived.  Do not edit live `~/apps/*-EFFORT-LOG.md` or repo `docs/EFFORT-LOG.md`.  Linear is the write surface; Zulip closeout still moves in parallel.

## Do not

- Prepend `~/apps/mac-collab` to `PATH` or paste `MAC_COLLAB_TOKEN` into curl "to be safe."  Use `board` at `~/.local/bin/board`.
- Use Linear as the only closeout.  Zulip still moves.
- File a duplicate because you did not `board list --search` first.

## Canon

- `/Users/jay/apps/AGENT-SYNC.md` § Linear / THE BOARD
- `/Users/jay/apps/EFFORT-LOG-PROTOCOL.md` (stub)
- `board --help` / `board file --help`
