# Codex Model Catalog Fallback — 2026-09-13

## Scope

The Codex app-server `model/list` response remains authoritative when available.  The static rows in `server/drivers/codex-catalog.ts` are only a source fallback when the installed CLI cannot answer, and therefore are not availability proof for an account or transport.

The fallback now follows the current visible local Codex metadata: `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, and the text-only CLI specialty `gpt-5.3-codex-spark`.  Its source fallback default is `gpt-5.6-sol`.  GPT-5.4 and GPT-5.4 Mini were retired from Codex ChatGPT sign-in on 2026-08-31 per the [official Codex model guidance](https://learn.chatgpt.com/docs/models); speculative `o3` rows were also removed from this fallback.

Dynamic catalogs, provider-qualified local models, and explicit stored selections remain preserved.  A stored retired official slug is surfaced as a custom provider-qualified selection rather than silently dropped.

## Pricing Evidence

The [official GPT-5.5 model page](https://developers.openai.com/api/docs/models/gpt-5.5) lists API pricing of $5 input, $0.50 cached input, and $30 output per 1M tokens, with the `gpt-5.5` alias resolving to the dated snapshot `gpt-5.5-2026-04-23`.  The [GPT-5.6 Sol page](https://developers.openai.com/api/docs/models/gpt-5.6-sol) explicitly documents the `gpt-5.6` alias as routing to Sol; no Terra/Luna alias is documented there.  These are API prices and do not describe Codex OAuth or ChatGPT subscription quota.

The broader dated [research report](../audits/2026-09-13-model-prices-and-routing.md), including current provider pricing and alias/transport boundaries, is committed with this rollout.  It records Terra as the rational API coding recommendation while keeping the OAuth/subscription catalog and API token pricing separate.  It also records the Anthropic API Fable 5.1 ID separately from an apps gateway that may still resolve its Fable 5 alias.

## Verification

- `pnpm typecheck`
- `vitest run server/drivers/codex-catalog.test.ts` — 14 passed, covering dynamic catalog precedence, fallback source/default, current rows, Spark CLI-only handling, provider-qualified models, and stored-selection preservation
- `git diff --check`
