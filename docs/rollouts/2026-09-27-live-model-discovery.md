# Live Model Discovery For Every Engine

**Board:** `64b987e317374b0fba22ab981f0cd294`  ·  **Lane:** `~/apps/botfleet-minimax-model-discovery` (`minimax/model-auto-discovery`)  ·  **Landed:** 2026-09-27

## The Ask

Owner: make it so BotFleet automatically gets updated model listings for all engines.

## The Honest Answer

BotFleet already refreshed most engines from their real source. The audit below found
three classes, not one, and the gap was not "every engine is hardcoded" — it was that the
shared mechanism did not exist, so each driver hand-rolled its own and three engines never
got one at all.

| Engine | Driver kind | Catalog source | Class |
| --- | --- | --- | --- |
| MiniMax | `minimax` | `GET {apiUrl}/models`, 60 s probe memo | live (existing) |
| Custom / OpenAI-compatible | `openai-compat` | `GET {url}/models` | live (existing) |
| Codex | `codexAgent` | ACP `model/list` + per-provider `GET {baseUrl}/models` | live (existing) |
| Cursor | `cursorAgent` | `cursor-agent models`, 5 min cache | live (existing) |
| opencode-go | `opencodeGoAgent` | CLI catalog probe, last-good kept | live (existing) |
| Pi | `pi` | CLI probe | live (existing) |
| Claude | `claudeAgent` | `~/.claude/settings.json` | local file (existing) |
| Grok Build | `grokAgent` | `~/.grok/config.toml` | local file (existing) |
| Antigravity | `antigravity` | local quota snapshot + `mergeLocalInject` | local (existing) |
| DeepSeek / Kimi | `deepseekAgent`, `kimiAgent` | local CLI config | local file (existing) |
| Droid | `droidAgent` | `~/.factory/settings.json` | local file (existing) |
| Local injects | shared | oMLX / Ollama / LM Studio probes | live (existing) |
| **Grok (API)** | `grok` | **`GET {url}/models`, new** | **live (this PR)** |
| **Harness / DSH** | `dshAgent` | **`~/.dsh/settings.yaml` (`llm-pi-ai.providers`), new** | **local file (this PR)** |
| Box | `boxAgent` | static 3 rows | static — see below |
| Qwen | `qwenAgent` | local injects only | static — see below |

## What Changed

### 1. `server/drivers/model-discovery.ts` (new)

One module for the shape every API-key engine shares. Three exports:

- `fetchProviderModels` — `GET {baseUrl}/models`, normalized across both provider shapes
  (bare array, and `{ data: [...] }`). Never throws; a miss is `{ ok: false }`.
- `mergeDiscoveredModels` — folds rows into a catalog, keeping the hand-written label,
  badge, and context window for ids already known, and taking the provider's own `name`
  for a genuinely new one. Returns `null` when the merge would be empty so the caller
  keeps its catalog.
- `createModelDiscoveryProbe` / `discoverModelCatalog` — a memoized probe plus the
  probe-to-catalog step.

The rules it encodes, which is the point of having one module:

1. **A discovery miss is never fatal.** A blank or malformed list must never blank a picker.
2. **Hand-written metadata wins.** A live row may refresh which ids exist, never how they
   read. Labels, badges, and `contextWindow` are product copy and the sizing input for
   `server/context-rebuild.ts`.
3. **A removed id stays removed.** Nothing re-aliases a retired id to its replacement, per
   `docs/rollouts/2026-09-18-latest-model-ids.md`.
4. **The current default holds** across a refresh, so opening the picker does not move a
   selection out from under the user.

The TTL helper exists because the drift was the actual bug: MiniMax memoed at 60 s, Cursor
at 5 min, opencode kept a last-good in-process, and three engines memoed nothing. A registry
`describe` therefore fanned out into a burst of duplicate `/models` calls. One helper, one
TTL per call site, and concurrent describes share the in-flight promise.

### 2. `server/drivers/grok.ts` — live xAI catalog

xAI publishes an OpenAI-compatible `GET {url}/models`, so the three hand-written Grok rows
become a starting point rather than the only source of truth. 60 s TTL, matching MiniMax.

### 3. `server/drivers/acp/dsh.ts` — live Harness catalog

The Harness install declares the models it can serve in its own settings file, under
`llm-pi-ai.providers.<id>.models[]` with `id` / `name` / `contextWindow`. That file is the real
source of truth for "what can this DSH run right now"; the catalog compiled into the Harness
package goes stale the moment the owner edits a profile or the package is pinned to an older
release. Reading it is the same move `claude.ts` makes against `~/.claude/settings.json`, and it
plugs into the `resolveModels` hook `acp/core.ts` already calls, so the existing boot-deadline
race and last-usable-catalog fallback apply unchanged.

**The live read unions rather than replaces, and that is the load-bearing decision.** A DSH
profile is a *partial* source: the one on this Mac declares only the `minimax` provider block,
while the static catalog is `deepseek-v4-flash`, `deepseek-v4-pro`, `MiniMax-M3`. Treating the
file as authoritative would have silently deleted both DeepSeek rows from the picker — and
`deepseek-v4-flash` is the static default. A partial source can add models; it cannot retire
them. Retiring a row is an explicit entry in `DSH_EXCLUDED_MODEL_IDS`, which is how
`MiniMax-M2.7` is already handled, so the live read and the static fallback cannot drift apart.
`readClaudeModelCatalog` already unions the same way, so this is the house pattern rather than a
new idea.

On the live install the read is not a no-op: it adds `MiniMax-M2.7-highspeed`, which the static
catalog was missing, and drops nothing. A test asserts that against the real
`~/.dsh/settings.yaml` alongside the synthetic fixtures, so a future change cannot quietly turn
the whole feature into dead code.

Two provider-map locations are accepted — `llm-pi-ai.providers` (the live shape) and a top-level
`providers` — so a profile written either way works.

`STATIC_DSH_MODELS` remains the floor for every failure mode: no settings file, unparseable
YAML, a profile with no `models` block.

`readDshSettingsPath` reads `environment.HOME`, not `homedir()`, because the ACP core hands
`resolveModels` the child environment it will actually spawn the CLI with.

## What Was Deliberately Not Done

- **`boxAgent` stays static.** The three rows are what the private box service on
  `ascii.dev` offers. There is no `/models` endpoint on it to discover from, and inventing
  one would mean guessing at a third-party API. The honest state is a static catalog.
- **`qwenAgent` stays empty-plus-injects.** It has no catalog of its own by design; it
  surfaces whatever a local inject is running.
- **No `refreshModels` was added to drivers that already have a live source.** Claude,
  Codex, Cursor, opencode, Pi, and the local-inject prober all work. Rewriting them onto the
  new module is a separate, behavior-neutral cleanup.

## Verification

- `server/drivers/model-discovery.test.ts` — 27 new tests: both response shapes, bearer
  header pass-through, non-2xx and thrown-network as misses, label/badge/contextWindow
  preservation, new-model labeling, retired-model removal, exclusion, default retention and
  move, dedupe, malformed-row tolerance, empty-to-`null`, TTL sharing across concurrent
  callers, TTL sharing across *sequential* callers, TTL expiry, and a rejected probe not
  poisoning the cache.
- `server/drivers/grok.test.ts` — 9 new tests, including a burst of three concurrent
  refreshes collapsing to one request, and no request at all without a key.
- `server/drivers/acp/dsh.test.ts` — 16 new tests: a model the static catalog never had, the
  union keeping every static row from a minimax-only profile, the default never moving, the
  live `llm-pi-ai.providers` nesting, a top-level `providers` map, `contextWindow` carried
  through, the M2.7 exclusion holding against the file, five distinct fallback paths,
  malformed-row tolerance, `DSH_HOME` precedence, multi-provider profiles, and a check against
  the real `~/.dsh/settings.yaml`.
- Full gate: `pnpm typecheck && pnpm test`.

## Follow-Ups Worth Filing

- `boxAgent` needs an owner answer on whether `ascii.dev` exposes a models endpoint before
  it can join the live set.
- `src/lib/minimax-prices.ts` and `server/model-fallback.ts` index catalogs by static id, so
  a live-only id reads as unpriced and falls back to a pattern table. Once a live engine
  starts surfacing ids the price table has never seen, those two want a live-price or
  unknown-price path.
