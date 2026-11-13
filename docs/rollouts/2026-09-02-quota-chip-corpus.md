# Quota Chip Corpus (Official Provider Wording)

**Seat:** BF-Plumber / GROK.  **Worktree:** `~/apps/botfleet-plumber-quota-corpus`.  **Branch:** `grok/quota-chip-corpus`.  **Board:** `a59fcff2`.

## Why

PR #119 failovers on quota/session-limit chips, but the matcher only knew a few phrases.  Live probes showed Codex `You've hit your usage limit` and Cursor `Upgrade your plan to continue`, which the old regex missed when those chips count as assistant text.

## What landed

- Official chip corpus in `server/model-fallback.test.ts` (Grok, Claude, Gemini, Codex, Cursor, DeepSeek, Kimi).
- `QUOTA_OR_CAP` / retry classifier expanded to those strings.
- Near-cap warnings (`Approaching 5-hour limit`, 80% used) still do **not** failover.

## Live engine probe (2026-09-02, EngineProbe)

Available engines that ran a shell tool: grok-4.6, claude-sonnet-5, claude-opus-5, gemini-3.7-flash-high, gemini-3.1-pro-high, cursor/auto, kimi-code/k3.

Codex `gpt-5.6-luna` hit `You've hit your usage limit` and **fell over to gemini-3.7-flash-high**.  DSH flash/pro failed `DSH CLI auth missing` (file `~/.dsh/.credentials.yaml` exists) and also fell over to Gemini.

Unavailable this Mac: droid, opencode, computer/Box, openaiCompat, qwen, hermes, pi, DeepSeek API key.

## Near-cap alert

In room BotFleet.app: `@Plumber near-cap <engine>` plus the chip text if you have it.  Engine is one of `grok`, `claude`, `codex`, `cursor`, `antigravity`, `dsh`, `kimi`.

## Verify

```bash
cd ~/apps/botfleet-plumber-quota-corpus
pnpm exec vitest run server/model-fallback.test.ts server/drivers/retry.test.ts
```
