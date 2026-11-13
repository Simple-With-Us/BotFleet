# Latest Model IDs Across The Static Driver Catalogs — 2026-09-18

## Context & Objective

Sibling-app slice of a fleet-wide model-catalog cleanup (owner request, board
`f886b14b` on Socratic.Trade; this repo's item `654d564b`).  Four of
BotFleet's driver-level static model catalogs were one or more generations
behind the fleet's current lineup — verified against a live OpenRouter model
dump (446 models, fetched 2026-09-18) and the fleet's own
`docs/audits/2026-09-13-model-prices-and-routing.md`.

## Changes Made

- `server/drivers/grok.ts` — the xAI-API-key driver's `MODELS` catalog was
  `{default: "grok-4", options: [grok-4, grok-4-fast, grok-3-mini]}`.  None of
  those three ids appear in the live OpenRouter list any more, and the
  sibling ACP Grok CLI driver (`server/drivers/acp/grok.ts`) already defaults
  to the current lineup.  Replaced with
  `{default: "grok-4.6", options: [grok-4.6, grok-4.5]}` — the same two
  models the ACP driver offers.  `generateText`'s own hardcoded
  `"grok-3-mini"` call was left untouched (out of scope for this catalog
  fix); flagged as a follow-up.
- `server/drivers/claude.ts` — `STATIC_CLAUDE_MODELS` listed
  `{id: "claude-fable-5", label: "Claude Fable 5"}`.  The current Anthropic
  API id is `claude-fable-5-1` (confirmed against
  `docs/audits/2026-09-13-model-prices-and-routing.md`'s own finding and the
  live OpenRouter list, which carries `anthropic/claude-fable-5.1` and no
  bare `anthropic/claude-fable-5.1`-adjacent non-versioned row).  Updated to
  `{id: "claude-fable-5-1", label: "Claude Fable 5.1"}`, matching this
  catalog's existing hyphenated-id / dotted-label convention (e.g.
  `claude-haiku-4-5` / "Claude Haiku 4.5").
- `server/drivers/codex-catalog.ts` — `STATIC_CODEX_MODELS.default` was
  `"gpt-5.6-sol"` even though `"gpt-6-astra"` was already the first row in
  the same options list.  Changed the default to `"gpt-6-astra"`; the
  options list (and every other row) is unchanged.
- `server/drivers/minimax.ts` — `MODELS.options` carried a plain
  `MiniMax-M2.7` row priced identically to MiniMax-M3's own <=512K-token
  tier ($0.30/$1.20 per million) for a fifth of the context (204,800 vs
  1,000,000) — M3 strictly dominates it.  Removed that one row.
  `MiniMax-M2.7-highspeed` stays: it is priced at $0.60/$2.40, genuinely
  different from M3's rate at any input size highspeed's own 204,800-token
  context could hold (compared directly against `MINIMAX_PRICE_PER_MILLION`
  in the same file per the task's own instruction).  `MINIMAX_PRICE_PER_MILLION`
  itself, and its client-side display copy in `src/lib/minimax-prices.ts`,
  were left untouched — the plain M2.7 price row still prices a turn if a
  bot's already-saved selection or a typed custom slug still names it, so a
  retired catalog row does not silently lose cost tracking.

## Decisions & Trade-offs

- **`server/drivers/boxagent.ts`** (a separate, third-party remote substrate
  driver — box.ascii.dev's own agent facility) also carries a
  `"claude-fable-5"` row and a stale `"gpt-5.4"` Codex row.  Left untouched:
  this file was not in the task's scope, its accepted model ids are decided
  by that third-party substrate rather than verified against the live
  OpenRouter list used here, and touching it risked an unverified behavior
  change.  Worth a follow-up if the owner wants it audited the same way.
- **`server/drivers/acp/dsh.ts`** (the DeepSeek Harness ACP driver) lists its
  own separate `STATIC_DSH_MODELS`, which happens to include `MiniMax-M3`
  and plain `MiniMax-M2.7` (no highspeed row) as models reachable *through*
  the `dsh` CLI's own harness.  Left untouched — this is a different
  driver's own reported catalog, not a copy of `minimax.ts`'s, and was not
  in the task's scope.
- MiniMax price tables (`MINIMAX_PRICE_PER_MILLION` in both `minimax.ts` and
  `src/lib/minimax-prices.ts`) were deliberately NOT pruned to match the
  narrower model list — see above.  This keeps `src/lib/minimax-prices.ts`'s
  existing coverage test (`has exactly one row per catalog model id`)
  unaffected without editing it.
- No canonical-id aliasing was added anywhere (owner rule: a removed/renamed
  catalog id is never re-aliased onto its replacement, so historical
  per-model stats are never silently folded into a different model).

## Verification State

- `NODE_AUTH_TOKEN=$(gh auth token) pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm test` (full repo verify-gate script)

(exact pass/fail state and counts recorded in the commit this note ships
with)

## Next Steps & Blockers

- Follow-up flagged (not actioned here): `server/drivers/grok.ts`'s
  `generateText` still hardcodes the now-removed `"grok-3-mini"` id for bot
  title/summary generation, independent of the `MODELS` catalog above.
- If the owner wants `boxagent.ts` and `acp/dsh.ts`'s own catalogs
  fleet-audited the same way, that is separate follow-up work, not part of
  this PR.

## Zero-Code Findings

None — every catalog named in scope was code-changed as described above.
