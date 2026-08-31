# BotFleet Effort Log — cross-agent board
Protocol: /Users/jay/apps/EFFORT-LOG-PROTOCOL.md (canonical). Live board: this file
(mirror: docs/EFFORT-LOG.md in the repo). As of 2026-08-29.

## Deployed
- [AG] 2026-08-29 — Always-on iMessage bidirectional relay daemon (`botfleet-imessage-relay`) and LaunchAgents (`com.jay.botfleet-imessage-relay` + `com.jay.botfleet-server`) connecting 12 BotFleet bot group chats in Messages.app with BotFleet backend.

## Completed
- [AG] 2026-08-30 — iOS app updates: Added Model choices, custom channel photos UI, fixed Return key, and fixed auto-scroll behavior.

## In Progress
- **2026-08-31 - GROK - IN_PROGRESS - Top-to-bottom full-stack audit (web all sizes, native Electron+iOS, backend).** Mac ~/apps/botfleet-grok-audit @ grok/full-stack-audit. Board f5abf14d. Issue #22.

## Planned / Reserved
- **2026-08-31 - GROK - PLANNED - Model fallbacks almost never run (error activity counts as produced).** Board e556f063. P0.
- **2026-08-31 - GROK - PLANNED - Default skin System Auto boots Midnight (owner light-first).** Board 359e1d07.
- **2026-08-31 - GROK - PLANNED - Electron open-file/show-in-folder skip confinement; window-open no protocol allowlist.** Board 6c38e297.
- **2026-08-31 - GROK - PLANNED - Auto-approve + Always-allow Bash:curl covers curl|sh; control-client fails open.** Board cd6bf0cd.
- **2026-08-31 - GROK - PLANNED - Composio broker REGISTRATION_MODE=open on workers.dev.** Board 94850736.
- **2026-08-31 - GROK - PLANNED - iOS chat images use /api/attachments URLs; agents need disk path.** Board a9683ae2.
- **2026-08-31 - GROK - PLANNED - README + botfleet.app Download CTA point at wrong GitHub artifacts.** Board d9bd4316.
- **2026-08-31 - GROK - PLANNED - Local VM stall watchdog never releases idle fence.** Board a5dabdea.

## Changelog of this log
- 2026-08-31 — GROK claimed top-to-bottom full-stack audit (issue #22, board f5abf14d).
- 2026-08-29 — Deployed always-on iMessage bidirectional relay for 12 BotFleet bots (AG).
- 2026-08-28 — bootstrapped by onboard-new-app.sh.
