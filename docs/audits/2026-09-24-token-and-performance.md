# BotFleet Token And Performance Review — 2026-09-24

Scope: `origin/main` at `2ef623a8`, Mac runtime reads on 2026-09-24, and official provider pricing pages linked below.  Source findings are not measured production savings.  The Mac was still running 1.0.31 at `ad758edf` with five active operations and `safeToRestart: false`; this review does not claim an installed update or a live performance change.

## Token Cost And Context

| Finding | Evidence | Action |
|---|---|---|
| Chat-completions and room history are replayed without a byte cap | `server/index.ts` selects up to 40 direct-chat messages for MiniMax, Grok, and OpenAI-compatible drivers; room turns separately concatenate up to 30 messages.  A large prior message can be resent on each request and tool round. | This branch caps prior direct-chat text replay at 128 KiB, keeps recent complete messages, clips one oversized newest prior direct-chat message, and marks omitted history.  Room context drops oversized older messages under the same budget, preserving the newest when it triggered the turn; on card continuations, even that stored message is prior history and may be clipped.  The current direct-chat prompt and native CLI session path are untouched.  Board `93e15d9a`, issue #540. |
| Scheduled and webhook turns can accumulate long source-thread history | `server/routines.ts` reuses a source thread.  The replay cap limits each API call but does not compact the durable thread or establish a measured saving. | Rollover or summarization needs a separate design preserving receipts, links, and approvals.  Reconcile peer PR #535's effort-log claim before implementing it. |
| Engine/task mismatch can induce expensive retries | Director already owns capability gating on board `5fc628cb`; no runtime spend sample was available. | Do not duplicate that lane.  Require a tested dispatch-time capability decision, with a visible failure instead of repeated doomed turns. |
| Unattended model downgrades | PR #533 owns this area.  Calendar schedules intentionally retain the saved Auto model in that PR; changing that is a product policy decision. | Evaluate actual task outcomes and provider quotas before selecting a cheaper model.  Do not equate API list price with subscription marginal cost. |

The maximum replay reduction depends on actual message sizes and tool-round counts; neither was sampled.  The 128 KiB cap bounds **prior text replay**, not the new prompt, system instructions, tools, images, or provider-native sessions.  A 40-message cap alone offered no byte bound.

## Runtime Performance Findings

| Priority | Finding and evidence | Tracking |
|---|---|---|
| P1 | Computer-capable direct turns poll a cloud/VPS screen every six seconds even without a viewer or tool use (`server/index.ts` screen poller).  Source estimates 100–500 KiB per capture; this implies repeated capture and serialization work, not a measured network total.  Make polling viewer-aware and preserve tool-event/final captures. | Board `f7de4597`. |
| P1 | The `messages=200` endpoint obtains the whole SQLite thread before paging, and `server/store.ts` retains full histories in its process cache.  A synthetic 10,000-row, 900-character test took 196 ms to parse and retained 21.5 MiB; this is not a Mac production profile.  Query pages directly and bound cache residency. | Board `c524b2b1`. |
| P2 | Sidebar sorting rebuilds visible-message maps inside comparisons.  A synthetic 100-bot × 200-message sort took 39 ms.  Precompute activity and preview once per bot.  Streaming Markdown also reparses cumulative text during animation-frame updates; profile the live view before changing its cadence. | Board `41859498`. |
| P2 | `server/message-db.ts` text search uses a synchronous, unindexed `%term%`/JSON extraction scan.  A synthetic 30,000-row miss took 45.7 ms with a temp sort.  Evaluate FTS or worker isolation against realistic data before choosing an index. | Include in board `c524b2b1` profiling scope. |

Open peer PRs #532 and #535 cover webhook slimming, filtering, cursors, and connectivity; #533 covers model policy; #539 covers the picker.  These are peer-owned and unmerged as observed.  No finding above is treated as fixed merely because an open PR exists.

## Current Model Economics

USD per one million **API** tokens as of 2026-09-24, in `input / cached-read / output` order unless a row says cache-hit then cache-miss.  Subscription and OAuth usage may use quotas or pools that do not follow these prices.  Long-context, peak/off-peak, batch, cache-write, and priority prices can differ.  Prices and catalogs can change; linked provider pages are authoritative.

| Provider and model | API price | BotFleet transport conclusion |
|---|---|---|
| OpenAI GPT-6 Luna / Sol / Astra | $0.10/$0.01/$0.50; $2/$0.20/$10; $10/$1/$50 | Codex uses ChatGPT OAuth and dynamic `app-server model/list`; the static picker is a fallback.  These API rates do not bill Codex subscription turns.  Requests over 272k prompt tokens have higher published rates.  [Official pricing](https://developers.openai.com/api/docs/pricing). |
| Anthropic Haiku 4.5 / Sonnet 5 / Opus 5.5 / Fable 5.1 | $1/$0.10/$5; $2/$0.20/$10; $4/$0.20/$20; $10/$0.25/$50 | Claude Code subscription and API are separate.  Opus 5.5 supersedes BotFleet's static Opus 5 row on the API (Opus 5 is $5/$0.50/$25).  CLI family aliases such as `opus` may move, but the apps gateway may resolve differently.  [Models](https://platform.claude.com/docs/en/models/overview), [pricing](https://platform.claude.com/docs/en/about-claude/pricing), [CLI aliases](https://code.claude.com/docs/en/model-config). |
| MiniMax M3 / M2.7 Highspeed | $0.30/$0.06/$1.20 through 512k; $0.60/$0.06/$2.40 | Direct API M3 has 1M context and is BotFleet's cost default; Highspeed has 204.8k context.  M3 above 512k input is $0.60/$0.12/$2.40.  Token Plan differs.  [Paygo pricing](https://platform.minimax.io/docs/guides/pricing-paygo). |
| DeepSeek Flash / Pro | Peak cache-hit/cache-miss/output: $0.006/$0.30/$1.20; $0.044/$1.32/$3.96 | Off-peak rates halve.  `deepseek-v4-flash` is an accepted legacy name for canonical `deepseek-flash`; the DSH catalog belongs to Harness, so BotFleet must not edit its shape here.  [Official pricing](https://api-docs.deepseek.com/quick_start/pricing). |
| xAI Grok 4.6 / 4.5 | $2/$0.50/$6; $2/$0.30/$6 below 200k | Long-context rates double.  Grok CLI and direct API have distinct billing.  [Official pricing](https://docs.x.ai/developers/pricing). |
| Google Gemini 3.8 Flash | $0.75/$0.075/$3.75 through 2026-12-31 | Antigravity effort-suffixed catalog IDs are managed CLI names, not Google API model IDs.  Do not display this API price as Antigravity cost.  [Official pricing](https://ai.google.dev/gemini-api/docs/pricing). |
| Cursor Composer 2.5 / Fast | $0.50/$0.20/$2.50; $3/$0.50/$15 | Cursor's pool and overage rules differ from raw API billing.  [Composer model](https://prod.cursor.com/docs/models/cursor-composer-2-5), [pool pricing](https://prod.cursor.com/docs/models-and-pricing). |
| Kimi Code K3 / K3-256k / kimi-for-coding | Public per-token Kimi Code membership rate not established | Keep membership quota separate from Moonshot Open Platform API rates.  [Official models](https://www.kimi.com/code/docs/en/kimi-code/models.html). |

The rational default depends on task quality and quota, not price alone.  Luna's low API rate supports cheap mechanical work, while Sol/Astra remain justified when they finish harder tasks in fewer attempts.  Keep legacy/specialty Codex rows only when the live OAuth catalog exposes them or users have saved selections; a static fallback does not prove availability.  Provider `*_latest` aliases should be used only when **that exact transport** documents and accepts them.  No cross-transport alias substitution was verified here.

## Mac, Recall, And Telemetry Boundaries

- The Mac's runtime returned 1.0.31 at `ad758edf`, first with five active operations and then 12; `safeToRestart` remained false.  Installation is deferred to the updater's active-work gate (board `6661ceea`).  PR #526's transition code is an ancestor of the Mac server checkout; the separate machine wrapper still lacks its optional target bootstrap.  The Mac has not been updated to current `origin/main` or to the bundle-ID rename PR #524.  Confirm transition capability on every Mac before applying that rename.
- `/api/telemetry/status` reported 293 acknowledged batches, 20 failed batches, 529 failed attempts, with a recent ACK in the first read.  A later status request timed out; these counters do not establish a current retry rate or a token expense.  Board `0e195d95` tracks classification and repair.
- `/api/recall/status` reported configured but degraded readiness.  A settings or health response is not proof of a successful protected search; board `c01901af` tracks diagnosis and actual query verification.
- This pass did not verify complete per-provider usage/cost delivery to Usage Monitor or Sentry.  Token counts, cache categories, context windows, retry/fallback attribution, and subscription versus API cost should be checked end-to-end with real accepted envelopes before coverage is claimed.
- Source audit found real-turn `latencyMs` is omitted from `server/index.ts` telemetry calls, so the payload defaults to zero; the existing payload test injects a synthetic value.  Board `8f362950` tracks actual turn-duration measurement.
- Antigravity reads `cache_read_tokens` but drops the cached-input count on both live and terminal usage.  Board `f4172bb0`, issue #542, owns the isolated fix.  ACP drivers currently keep only input/output and return null cost, and fallback/transport attribution is absent from the Usage Monitor envelope; board `2c6611a1` tracks provider-by-provider completeness.
