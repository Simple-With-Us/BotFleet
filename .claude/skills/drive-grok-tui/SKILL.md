---
name: drive-grok-tui
description: Drive a live Mac Grok TUI session from any local agent (Claude, Cursor, Grok, Shellular, this TUI, …). List chats with idle/working/needs-input, peek or tail the transcript, inject a prefixed follow-up, await the reply via disk poll, or cancel. Use when you need to send work into an already-open grok terminal instead of spawning grok-acp :12419.
---

# Drive a live Grok TUI

> **Shared `~/.claude/skills`.** Monet, Claude/Fable, and (when active) Renoir all load this directory.  Do not treat the word Monet in examples as proof of your seat.  Pin `AGENT_SEAT` / `AGENT_TAG` from the logged-in account before Slack or `board --by`:
> - Monet → `MONET`, Notes `Monet`, `monet/`, `~/apps/<app>-monet`
> - Claude / Fable → `CLAUDE`, Notes `Claude`, `claude/`, `~/apps/<app>-claude`
> - Renoir → `RENOIR`, Notes `Renoir`, `renoir/`, `~/apps/<app>-renoir`
> Cursor, Grok, Grok Bot, Codex, AG, DeepSeek, Kimi, and Fx have their own skill dirs and must not take identity from here.


The Mac Grok TUI joins `~/.grok/leader.sock`.  Any local agent can attach
through `grok-drive.py`.  Do **not** spawn a second `grok-acp`
on `:12419` to talk to those chats.

## CLI

```bash
python3 ~/apps/grok-acp-runtime/grok-drive.py list
python3 ~/apps/grok-acp-runtime/grok-drive.py peek --session-id ID --tail 8
python3 ~/apps/grok-acp-runtime/grok-drive.py tail --session-id ID --lines 12
python3 ~/apps/grok-acp-runtime/grok-drive.py prompt \
  --session-id ID --cwd DIR --prompt "…" --from-name CLAUDE
python3 ~/apps/grok-acp-runtime/grok-drive.py await --session-id ID --timeout 180
python3 ~/apps/grok-acp-runtime/grok-drive.py cancel --session-id ID --cwd DIR
```

- `list` rows include `live`, `turnState` (`idle` / `working` / `needs-input`), title, `lastTurnSummary`.
- `prompt` prefixes `[from: NAME]` (`--from-name`, else `$AGENT_TAG` / `$AGENT_SEAT` / `remote`).
- `prompt` refuses a working / needs-input session unless `--queue`.
- `prompt` returns `queued: true` as soon as the TUI accepts the message.  It does **not** wait for the turn.
- `await` (or `--await-reply N` on prompt) polls disk until the turn is idle or needs-input.  That is how you read the reply.  Do not `--wait` on ACP.
- Peek/tail/await never `session/load` a live chat (load hangs ~45s).

## Do not

- Start a second `grok agent serve` or bind `:2419`.
- `session/load` a chat the TUI already has open.
- `--wait` on ACP for a live TUI reply (the wait *is* that TUI turn).
