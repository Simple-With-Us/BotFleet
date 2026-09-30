# Model Lineage, Latest Choices, and Saved-Selection Migration (2026-09-30)

Board row `da11b074`.  Owner asks: stale models should not be selectable, Grok 4.5 and 4.6 should go to Grok 4.7, every Sonnet should move to Sonnet 5.5 or the latest one, and the same should happen automatically for other engines when a newer model in the same class costs within about 25%.  The engine settings should offer "Latest Grok", "Latest Sonnet", and "Latest Luna", while the chat header and every recorded row show the model that actually ran.

## One Source Of Truth

`shared/model-lineage.ts` holds, per engine (`driverKind`):

- **Model classes.**  Claude: Fable, Opus, Sonnet, Haiku.  Codex: Astra, Sol, Terra, Luna.  Grok: Grok, Grok Build Fast.  Droid carries all three families.  A class member is recognised from its id pattern, so a newly listed version is classified without a code change.
- **Version rank** from the id (`claude-sonnet-5-5` is 5.5, `gpt-5.6-luna` is 5.6, `grok-4.7` is 4.7).  A dated id ranks equal to its undated twin.
- **List prices** where known (Claude, from the Anthropic first-party table).  Codex and Grok Build ride subscriptions and have no per-token price here.
- **Retired ids** with their successor class: `claude-3-7-sonnet` (Sonnet), `grok-4.5` and `grok-4.6` (Grok), and `grok-3-mini` (no successor).

MiniMax, mcode, and the DeepSeek Harness are deliberately not classified yet (their catalogs belong to other lanes, and the DeepSeek V4.1 ids are not yet proven accepted on this Mac).  Adding them is one entry in `DRIVER_LINEAGE`.

## Latest Choices

A floating selection is stored as `{ "model": "claude-sonnet-5-5", "latest": "sonnet" }`.  `model` is always the real slug, so drivers, recorded usage, message rows, `activeModelSelection`, and clients that ignore `latest` (the shipped iOS app) all see the model that actually runs.  The harness keeps `model` pointed at the newest class member the instance's catalog offers:

- on every write (`checkedModelSelection`),
- right before every dispatch (`startTurn` and room rounds),
- on every catalog refresh (`GET /api/instances`), skipping working bots,
- at boot.

Codex's static fallback catalog is not trusted for this: a catalog that is exactly `STATIC_CODEX_MODELS` means the live `app-server` listing was unavailable, and nothing is resolved against it (the static rows have offered GPT-6 Luna, which this account's live catalog does not).  When the fallback rows carry a marker badge (the "Unverified" chip), that badge is what identifies the fallback, so a live listing that names the same ids is still trusted.

An older client that re-sends a floating entry without `latest` keeps it floating when the engine and model are unchanged.  The desktop picker sends `latest: null` when a person picks a pinned model.

## Hidden Superseded Models

`/api/instances` returns catalogs with retired ids and older class members removed (desktop, iOS, and the MCP tool all read it).  Validation and dispatch still read each engine's full catalog, so a saved older id keeps working until it is moved.

## Moving Saved Selections

- **Owner-directed, once** (marker `~/.botfleet/model-lineage.json`): every saved Sonnet (any version, including `claude-3-7-sonnet`) becomes Latest Sonnet, and every Luna becomes Latest Luna.  A selection pinned afterwards is never re-floated.
- **Every pass:** a retired id becomes Latest of its successor class.  A pinned older class member moves to the newest member when the blended list price (3 input : 1 output) changes by at most 25%; with no price on either side, a subscription CLI engine moves on the class match and an API-key engine stays.  The target must be offered by the instance's authoritative catalog.
- The pass covers bot and task `modelSelection` (primary and fallbacks) and `activeModelSelection`.  A fallback the pass made identical to the primary is dropped; a placeholder fallback that already matched it is kept.
- Each moved bot gets one notice in its active thread, and each move is logged (`model-lineage: …`).
- A write that introduces a retired id with no successor gets `400 retired model "…" in <slot>`.  A saved leftover does not block editing another slot, and custom or local ids no catalog lists still pass.

## No Aliasing

Only saved selections move.  Message rows, per-task and per-instance usage buckets, and per-model stats keep the slug that ran, as required by `docs/rollouts/2026-09-18-latest-model-ids.md`.

## Picker

- "Latest <Class>" rows at the top of each engine's list, each naming the model it runs now.
- The chat header chip names the model that runs; its tooltip adds the Latest class and the slug.  Settings chips read "Latest Sonnet · Claude Sonnet 5.5".
- A saved id the catalog no longer offers gets a "Retired", "Superseded", or (only against a live catalog) "Not in catalog" badge, with a one-click "Switch To …".
- `src/lib/usage-plans.ts` no longer carries its own stale Claude, GPT, and Grok labels; those come from the model class.  Usage attribution is unchanged.
