# Rollout: Model Failover, Antigravity/Gemini Full Tooling, & Qdrant Agent RAG

**Date:** 2026-09-01  
**Author:** Antigravity (`AG`)  
**Branch:** `ag/model-failover-gemini-qdrant-rag`  
**Status:** Completed & Tested

---

## 1. Summary

This change addresses three core agent fleet requirements in BotFleet:
1. **Automatic Model Failover on Quota & Session Limits:** When any agent encounters a quota limit, session limit (e.g. `"You've hit your session limit · resets 7:10pm"`), rate limit (429), or abnormal engine crash, BotFleet automatically fails over to the next healthy model in the fallback chain or available registered engine instance without leaving the bot stuck or requiring manual retries.
2. **Full Tooling & Local Computer Control for Antigravity, Gemini, & All Harnesses:** Enabled `localComputerMcp`, `computerMcp`, `agentsMcp`, `composioMcp`, `phoneMcp`, and `qdrantMcp` across Antigravity (`agy` / `antigravityAgent`) and Gemini (`geminiAgent` / ACP) drivers, eliminating artificial fullAuto restrictions and outdated model catalogs.
3. **Shared Qdrant Agent RAG Integration & Settings UI:** Implemented a high-performance JSON-RPC stdio MCP proxy (`server/drivers/qdrant-proxy.ts`) supporting vector memory search, semantic storage, auto-collection provisioning, and deterministic embeddings, wired into all driver turns, and exposed via customizable settings in App Settings (`QdrantRagConnection.tsx`) and health API (`GET /api/qdrant/status`).

---

## 2. Key Changes

### A. Fallback Gate & Automatic Model Failover (`server/index.ts`, `src/components/ErrorRow.tsx`)
- Enhanced quota and session limit detection regex to identify session limit messages, rate limits, capacity exhaustion, and process crash errors.
- Fixed `turn.completed` fallback gate so that quota/session limit text errors or crash chips correctly trigger the next model fallback.
- Added smart auto-failover when no explicit fallback chain is configured, selecting healthy available fleet instances (Claude, Antigravity, Gemini, Codex, Grok).
- Added failover activity chip in the conversation transcript indicating model transition.

### B. Antigravity & Gemini Drivers (`server/drivers/antigravity.ts`, `server/drivers/acp/core.ts`, `server/drivers/acp/gemini.ts`)
- Updated `STATIC_ANTIGRAVITY_MODELS` with Gemini 3.7 Flash, Gemini 3.1 Pro, Gemini 2.5 Pro, and Gemini 2.5 Flash.
- Configured Antigravity driver capabilities to permit full tool execution (`localComputerMcp`, `computerMcp`, `agentsMcp`, `composioMcp`, `phoneMcp`, `qdrantMcp`).
- Updated Gemini ACP driver to mount phone and Qdrant MCP servers, and enabled local computer control.

### C. Qdrant Agent RAG MCP Proxy & Settings (`server/drivers/qdrant-proxy.ts`, `src/components/QdrantRagConnection.tsx`, `server/index.ts`)
- Stdio MCP server exposing `qdrant_search`, `qdrant_store`, `qdrant_get_context`, and `qdrant_list_collections`.
- Configuration schema and status endpoints (`/api/qdrant/status`, `/api/config`).
- Settings UI card with enable toggle, server URL, API key, collection name, and live connection test probe.

---

## 3. Verification & Test Results

- `pnpm vitest run server/qdrant-rag.test.ts` — **Passed (1/1)**
- `pnpm vitest run server/drivers/antigravity.test.ts` — **Passed (23/23)**
- `pnpm vitest run server/drivers/acp/acp.test.ts` — **Passed (42/42)**
- `pnpm vitest run server/drivers/claude.test.ts` — **Passed (58/58)**
- `pnpm typecheck` (`tsc -b && tsc -p tsconfig.server.json`) — **Passed (Code 0)**
- `pnpm build` (`vite build`) — **Passed (Code 0)**
