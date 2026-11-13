# 2026-09-04 — Agent RAG connection: probe timeout, real causes, Cloudflare Access

**Why:** Owner: Settings → Bot RAG could not confirm a working corpus, and
the HTTP path could not be made to work against a recall service published
behind Cloudflare Access.  Test Connection always answered "The local recall
CLI did not answer — set a Service URL in Settings".

**Cause:** Three separate faults, each of which hid the next.

1. The status probe ran `recall stats --json` with a 6s timeout.  Measured
   wall time of that exact command on the owner's Mac: 7.6s.  It timed out on
   every probe.  The bot-facing proxy already allowed 30s, which is why bots
   could use recall on the same host while the settings panel could not.
2. The probe's `catch {}` threw the cause away.  A timeout, a missing
   credential, a non-zero exit and unparseable output all collapsed into one
   fixed sentence, so nothing in the panel pointed at the timeout.
3. Cloudflare Access ignores a bearer credential outright and answers an
   unauthenticated request with a redirect to a login page.  BotFleet sent
   only `Authorization`, so the "API Key / Bearer Token" field in Settings
   could never make such a host work — and a login redirect looked like a
   generic connection failure.

**What landed**

- The probe gives the local `recall` CLI 30s, matching `executeRecallCli` in
  the bot-facing proxy — the same binary against the same corpus.
- A failed CLI call now says what happened: `it timed out after 30s`,
  `it exited 3: <stderr>`, `it printed output that was not JSON`, or
  `the executable could not be run`.  Anything the child printed goes through
  `redactSecretsInText` first, and the text is capped, so a URL or credential
  in stderr cannot reach the response.
- New `qdrant.accessClientId` / `qdrant.accessClientSecret` config: a
  Cloudflare Access service token.  Both halves or neither — one alone is not
  a credential.  `CF-Access-Client-Id` and `CF-Access-Client-Secret` are sent
  alongside the bearer (never instead of it) on every recall HTTP call, in
  `server/drivers/qdrant-proxy.ts` for bots and in the settings probe.
- A login redirect is named instead of guessed at: "the service redirected to
  a login page at `<host>`, which means it is behind Cloudflare Access — an
  API key or bearer token is ignored there, so add an Access service token
  (Client Id and Client Secret) in Settings".  Only the host of the login URL
  is echoed; the query string, which carries the original request, is not.
- The probe no longer reports ready on `/health` alone.  On an Access host
  `/health` is commonly the one public bypass while `/recall/*` is gated, so
  a real recall route is probed before the panel claims a connection.
- Settings → Bot RAG has an Access Client Id and Access Client Secret pair
  with a one-line explanation of what a 302 or login page means.  A failed
  test renders full width and wraps, because the useful part of these
  messages was exactly what the old single truncated line hid.
- GET `/api/config` reports `hasAccessClientSecret` / `hasAccessServiceToken`
  and never the secret, the same deal every other credential here gets.  An
  untouched secret field does not clear the stored token on save.

**Gate:** `pnpm typecheck` clean.  `pnpm exec vitest run`: 244 files passed,
2,709 tests passed, 19 skipped.  New coverage in
`server/recall-access.test.ts`, `server/drivers/qdrant-proxy.test.ts`, and
`server/index.test.ts`.

**Board:** `2fec8132`.  **Branch:** `claude/rag-connection-repair`.
