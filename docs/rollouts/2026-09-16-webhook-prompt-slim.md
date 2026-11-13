# Slim GitHub webhook prompts (Compiler timeout cascade)

Wed, Sep 16, 2026 (GROK pickup Fri, Sep 18, 2026 onto `grok/webhook-prompt-slim`)

## Why

Compiler's GitHub webhook turn showed four errors in one screenshot:

1. `session/prompt timed out` (Grok ACP, primary)
2. Fell over to `gemini-3.8-flash-high` (configured Antigravity fallback)
3. `local computer not mounted` (live Antigravity has no approval channel)
4. `prompt too large for Antigravity's argv-only print mode (713778 bytes)`

Live Mac harness `~/apps/botfleet-server` is detached `132b4560`.  origin/main already pipes Antigravity prompts over stdin, sets `localComputerMcp: true`, and caps mid-thread replay at 128 KB.  Those three do not land until this Mac rolls to origin/main.  They do not shrink the GitHub JSON itself.

GitHub deliveries dump `repository` / `sender` / `organization` URL farms twice plus `check_run.output` logs.  `serializePayload` pretty-printed that, then `foldPrompts` concatenated distinct deliveries.  The same oversized prompt then failed over to Antigravity.

## What changed

- Compact JSON.  GitHub payloads keep action, conclusion, branch, sha, check name, PR merged / merge_commit_sha, repo full_name, and push `pusher` `{ name, email }`.  URL farms and check logs drop.  `slimActor` is for User/Bot objects (`login`/`type`/`id`); push `pusher` uses `slimPusher` because GitHub's push payload is `{ name, email }`.
- Distinct folded batches cap at 64 KB and keep the newest deliveries.
- `prompt_too_large` does not walk the fallback chain.  The next engine gets the same prompt.

## Files

- `server/webhook-payload.ts`
- `server/webhook-payload.test.ts`
- `server/webhooks.ts`
- `server/webhooks.test.ts`
- `server/trigger-gap.ts`
- `server/trigger-gap.test.ts`
- `server/model-fallback.ts`
- `server/model-fallback.test.ts`

## Verify

```bash
pnpm exec vitest run server/webhook-payload.test.ts server/webhooks.test.ts server/trigger-gap.test.ts server/model-fallback.test.ts
pnpm typecheck
```

## Follow-ups

- Roll `~/apps/botfleet-server` to origin/main after this merges so live Antigravity gets stdin and local computer.  No extra-ship.  No --force-ship.
