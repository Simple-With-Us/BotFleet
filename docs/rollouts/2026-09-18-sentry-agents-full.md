# 2026-09-18 — BotFleet full Sentry Agents + Conversations (GB-FIXER)

## Summary

Upgrade the harness from basic `gen_ai.*` spans to the full [Sentry Agents](https://docs.sentry.io/product/agents/) product surface for project `simple-with-us/botfleet`.

| Requirement | Implementation |
| --- | --- |
| Agent tracing (runs, tools, model, errors) | Existing `server/sentry-ai.ts` `gen_ai.invoke_agent` / `execute_tool` / `chat` + error capture |
| Conversations | `setConversationId(threadId)` + `gen_ai.conversation.id` |
| User column | `setUser({ id: botId, username: botName })` (room id/name fallback) |
| Agent naming | `gen_ai.agent.name` = bot title |
| Model costs / tokens | `gen_ai.usage.*` on invoke/chat spans when drivers report usage |
| `dataCollection` genAI I/O ON by default | `Sentry.init({ dataCollection: { genAI: { inputs, outputs } } })` |
| Kill-switch | `SENTRY_AI_DATA_COLLECTION=0` (also `false` / `off` / `no`) |
| `streamGenAiSpans: true` | Explicit in harness init (SaaS) |
| MCP monitoring | Manual `mcp.server` spans on `scripts/mcp-server.ts` `tools/call` (custom JSON-RPC, not SDK `McpServer`) |

## LLM stacks

BotFleet drivers are CLI / ACP / raw OpenAI-compatible HTTP — not the OpenAI, Anthropic, Vercel AI, or LangChain Node SDKs — so official auto-instrumentation has nothing to patch. Provider mapping for Sentry (`genAiProvider`):

- Codex / OpenAI → `openai`
- Claude / Anthropic → `anthropic`
- Grok / xAI → `x_ai`
- Antigravity / Gemini → `gcp.gemini`
- DeepSeek / DSH → `deepseek`
- Kimi → `moonshot`
- MiniMax → `minimax`
- OpenAI-compat (OpenRouter, Groq, …) → `openai-compat`
- Cursor → `cursor`

## Kill-switch

```bash
# Default (omit): genAI inputs/outputs collection enabled at the SDK option layer
export SENTRY_AI_DATA_COLLECTION=1

# Disable genAI I/O collection (re-init / restart harness after change)
export SENTRY_AI_DATA_COLLECTION=0
```

Manual spans still omit raw prompts and tool arguments (credentials). The kill-switch gates the SDK `dataCollection.genAI` flag used by any auto-integration path and by MCP recording defaults.

## Verify in Sentry

1. Open [Sentry → Agents](https://simple-with-us.sentry.io/insights/agents/) for project **botfleet**.
2. Run any bot turn (e.g. Fixer / Monitor). Confirm an Agents Dashboard row named after the **bot title**, with tool and model children and token usage when reported.
3. Open **Conversations** — thread id groups the chat; **User** shows bot id/name (or room).
4. Optional: `SENTRY_AI_DATA_COLLECTION=0`, restart harness, confirm init fingerprint flips (`ai-data-off`) via Settings → Observability restart / boot logs.
5. MCP: `pnpm mcp` with `SENTRY_DSN` set — `tools/call` should produce `mcp.server` spans.

## Tests

- `pnpm exec vitest run server/sentry.test.ts server/sentry-ai.test.ts server/sentry-mcp.test.ts`
