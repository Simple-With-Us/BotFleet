# Gen AI Telemetry Correctness

## Summary

MiniMax Code, DSH MiniMax rows, and DeepSeek turns were landing in Sentry as
`deepseek` or with a null cost.  `execute_tool` spans also lacked
`gen_ai.system` / model.  This slice fixes the provider table, prices those
engines from the published catalog, stamps system/model on tool spans, and
adds opt-in prompt/response capture behind `SENTRY_AI_PROMPT_CAPTURE`.

## Why

The 2026-10-11 telemetry audit (section C item 5) showed 390 DSH MiniMax
spans billed as DeepSeek at $0, 229 mcode spans with cost null, and 14.8k
tool spans with no system/model.  Jay approved prompt capture as an opt-in.

## Files

- `server/gen-ai-cost.ts` — catalog estimator for MiniMax and DeepSeek
- `server/sentry-ai.ts` — provider table, catalog fallback, tool attributes,
  opt-in `gen_ai.input.messages` / `gen_ai.output.messages`
- `server/drivers/acp/core.ts` — catalog estimate at settle when the agent
  reports tokens but no charge
- `server/drivers/minimax.ts`, `server/drivers/openai-compat.ts` — pass
  formatted chat input into `withChatSpan`
- `docs/observability.md` — documents the prompt-capture flag

## Verification

```sh
pnpm exec vitest run server/gen-ai-cost.test.ts server/sentry-ai.test.ts server/drivers/acp/acp.test.ts
pnpm typecheck
```

Grok ACP still emits `cost: null` when the agent reports none.  Claude
subscription estimates still stay off `gen_ai.usage.cost`.  Prompt capture
stays off unless `SENTRY_AI_PROMPT_CAPTURE` is `1` / `true` / `yes` / `on`.

## Follow-ups

- Fleet-infra export via `SENTRY_FLEET_DSN` (no hardcoded secrets)
- Node/react `release` = git SHA, `@sentry/vite-plugin`, `@sentry/electron`,
  `@sentry/profiling-node`
