# Upstream Ports Ledger

Every change borrowed from [OpenMausBot](https://github.com/milind-soni/OpenMausBot) is recorded here so a later reviewer can skip what already landed.  BotFleet's history shares no ancestor with upstream, so each port is a re-implementation or a `git apply -3` of an upstream diff; the upstream PR is the reference, not a merge.  Nothing under upstream's `enterprise/` directory may be ported (see `LICENSING.md` upstream; it is not Apache 2.0).  Method and the full candidate list: `docs/audits/2026-09-24-upstream-openmausbot-review.md`.

Format: one line per port, newest last.

| Date (CT) | Upstream | What | BotFleet PR | Notes |
|---|---|---|---|---|
| Sep 24, 2026 | `shared/redact.ts` prefixes | `xai-`, `gsk_`, `hf_` secret key patterns | #598 | BotFleet's idempotence guard kept |
| Sep 24, 2026 | PR #774 | Chief roster drops live busy state | #617 | Plus BotFleet-only status-capsule timestamp fix |
| Sep 24, 2026 | `server/message-db.ts` `readThreadTail` | `LIMIT`-ed thread tail read | #602 | Feeds the thread-cache LRU |
| Sep 24, 2026 | PRs #1756, #1761 `server/connector-verdict.ts` | Per-bot Composio tool grants on the relay | #615 | `tools/list` filter added |
| Sep 24, 2026 | PR #1280 `server/thread-retention.ts` (shape) | Orphan and age sweep for transcript logs | #599 | BotFleet code; upstream's safety rule adopted |
| Sep 25, 2026 | Issues #1797, #1798 (open upstream; design only, no merged code) | `parseStoredConfigLeniently` validates `config.json` one top-level section at a time; a bad field is dropped and named, the rest survive | #TBD | BotFleet-original implementation; warning count surfaced via `GET /api/config` `configWarnings` and a Settings banner |
| Sep 25, 2026 | PR #1387 `messageAdded` (`src/state/store.tsx`) | A repeat delivery of an already-known message must not move the active leaf back onto it | #TBD | BotFleet has no client-side optimistic edit echo and the server's synchronous `bot.busy` gate already refuses a second edit while the first is in flight, so only the dedupe-clobber half of #1387 applies; ported that half only |
| Sep 25, 2026 | PR #1749 `ios/App/Island.swift`, `ChatListView.swift` | Never paint the collapsed island shell; drop the dead `hasIsland` flag | #TBD | Direct port; BotFleet's `ChatView.swift` has no `IslandShell` usage (upstream's third call site does not exist here) |
