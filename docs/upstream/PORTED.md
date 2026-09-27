# Upstream Ports Ledger

Every change borrowed from [OpenMausBot](https://github.com/milind-soni/OpenMausBot) is recorded here so a later reviewer can skip what already landed.  BotFleet's history shares no ancestor with upstream, so each port is a re-implementation or a `git apply -3` of an upstream diff; the upstream PR is the reference, not a merge.  Nothing under upstream's `enterprise/` directory may be ported (see `LICENSING.md` upstream; it is not Apache 2.0).  Method and the full candidate list: `docs/audits/2026-09-24-upstream-openmausbot-review.md`.

Format: one line per port, newest last.

| Date (CT) | Upstream | What | BotFleet PR | Notes |
|---|---|---|---|---|
| Sep 25, 2026 | Upstream #1705 / `server/resume-recovery.ts` | Protocol-state resume recovery (`classifyResumeFailure` / `mayReplay` / `recoveryPromptFor`); wired into `server/drivers/codex.ts` | #622 | Custom re-implementation.  ACP/`acp/core.ts` keepout skipped (CLAUDE wave-1).  Claude native resume left for a follow-up. |
| Sep 25, 2026 | `docs/verification/` + `docs/requirements/` | Process documentation: verification discipline and requirements template | PORT | Eight seeded recipes: chat-ui, routines, approvals, ios-companion, packaged-server, quota-fallback, mac-updater, connector-grants; issue #285 example |
| Sep 24, 2026 | `shared/redact.ts` prefixes | `xai-`, `gsk_`, `hf_` secret key patterns | #598 | BotFleet's idempotence guard kept |
| Sep 24, 2026 | PR #774 | Chief roster drops live busy state | #617 | Plus BotFleet-only status-capsule timestamp fix |
| Sep 24, 2026 | `server/message-db.ts` `readThreadTail` | `LIMIT`-ed thread tail read | #602 | Feeds the thread-cache LRU |
| Sep 24, 2026 | PRs #1756, #1761 `server/connector-verdict.ts` | Per-bot Composio tool grants on the relay | #615 | `tools/list` filter added |
| Sep 24, 2026 | PR #1280 `server/thread-retention.ts` (shape) | Orphan and age sweep for transcript logs | #599 | BotFleet code; upstream's safety rule adopted |
| Sep 25, 2026 | PRs #1205, #1248 | Per-thread snooze on the task record, desktop row control, iPhone badge | #637 | Composes with the bot-wide snooze; #1248's pinned retention reads as "keep the open thread in place" |
| Sep 25, 2026 | Upstream PR #1619 (`f1e066fd`) | Renders `mermaid` fenced code blocks as diagrams in chat messages | #633 | New `MermaidBlock.tsx` + shared `src/lib/stream-settle.ts` (settle debounce + hash), hand-merged onto `ChatMarkdown.tsx`'s existing Shiki chrome; theme follows `useResolvedSkin` (a11y-theme-copy) instead of upstream's CSS-var/MutationObserver read; upstream's show/hide-source toggle not ported |
| Sep 25, 2026 | PR #1228 `src/components/SidebarBotActivity.tsx`; PR #608 `src/components/routines/MiniMonth.tsx` | Roster row teammate-wait status chip; read-only routine-schedule calendar preview | #638 | No `waitingForTeammates` field on BotFleet — wait reason re-derived from peer-approval `allowKey` and comm/delegation chips; MiniMonth adapted from a date picker into a highlight-only preview |
| Sep 25, 2026 | PRs #1758, #1031 `server/system-prompt.ts`, `server/drivers/prompt-split.ts` | Stable/volatile system prompt split with per-session receipts; HTTP drivers carry the volatile half on the newest user message | #635 | Codex and ACP engines keep the joined prompt; `promptBytes` flattened for the strict v2 telemetry schema |
