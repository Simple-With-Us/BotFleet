# 2026-09-01 — BotFleet Sentry fleet adoption (Grok, `grok/sentry-fleet-adoption`)

## Summary

The Vite client already had Replay + `enableLogs` gated on `VITE_SENTRY_DSN`, but the Vercel production bundle did not inline a DSN.  Agent runs happen on the Node harness, which had no gen_ai spans.

- **Vercel** `VITE_SENTRY_DSN` set on production + preview for the existing `botfleet-site` project (not a new project).  `apps/site/build.mjs` inlines the browser SDK + Feedback + Replay when that env is present so the static marketing page can emit.
- **User Feedback** widget via `Sentry.feedbackIntegration` (light theme, auto-injected).  Replay stays 100% on error / 10% session, mask-all.
- **AI observability:** `@sentry/node` on the harness.  Drivers are CLI / ACP / raw OpenAI-compatible HTTP, not the OpenAI / Anthropic / Vercel AI / LangChain SDKs, so official auto-instrumentation has nothing to patch.  We emit the same `gen_ai.invoke_agent`, `gen_ai.execute_tool`, and `gen_ai.chat` spans those integrations would, keyed by `gen_ai.conversation.id` = thread id, plus model, tool names, token usage, and errors.  Prompts, transcripts, and tool arguments are not sent.
- **iOS Cocoa** no longer has a hardcoded DSN fallback.  `SENTRY_DSN` is XcodeGen `project.yml` / Info.plist only.
- Server init is gated on `SENTRY_DSN` (or `BOTFLEET_SENTRY_DSN`) so CI stays inert.

## Verification

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
