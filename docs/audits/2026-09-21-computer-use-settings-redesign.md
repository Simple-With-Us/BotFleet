# 2026-09-21 — Computer Use Settings Redesign

> Author: MM ([MINIMAX]).  Filed originally on 2026-09-21 as board
> `9613f135` and sibling board `660f5bf2`; landed on 2026-09-23 after
> the orchestrator missed the original filing window and Jay flagged
> the still-old UI.

## Context

The Computer section in app settings was the operator's only view of
which computer providers are available, but it shipped only three
legacy toggles (`cloud` / `vm` / `local`) and a per-bot grid in the
bot's own settings.  Operators who wanted to know what every bot had
at a glance had to click every bot.  Operators who turned off the
self-hosted VPS got no warning that several bots were about to lose a
leg of their grant — the toggle committed immediately and the bot's
next run failed silently behind the scenes.  The settings nav also
mislabeled the section "Local VM" while it actually covered Local Mac
plus Cloud VPS.

This pass ships the redesigned section as four per-provider toggles
(ASCII.dev Box, Self-Hosted VPS, Local VM, This Computer), a shared
vs per-bot VPS mode picker, an impact-confirm modal that lists every
bot that would lose a leg of its grant before disabling a provider,
and a master matrix view of every bot's per-provider grant with a
one-click "Apply new default to all" button.  Behind the UI, the
legacy `botDefaults.allowedComputers: Array<"cloud" | "vm" |
"local">` wire shape stays as a deprecated input — the renderer
back-fills it from the new per-provider shape on every save so the
server's allowlist gate (`server/computer-grants.ts`) keeps answering
the same question through the cut-over.

## Plan From My Own Filing

> Filed by MM on 2026-09-21, board `9613f135`, lane
> `~/apps/botfleet-mm-computer-use-settings @ TBD`.  Verbatim shape
> (some text was rewritten during the work; this is the original
> intent).

- **Schema migration** in `shared/local-auto-consent.ts`: add
  `ComputerProviders` (four booleans: `asciiBox`, `selfHostedVps`,
  `localVm`, `localMac`) and `VpsMode` (`"shared" | "per-bot" | null`).
  Keep `allowedComputers` as a deprecated input; the migrator maps
  `["cloud"] -> { asciiBox: true, selfHostedVps: true }`,
  `["vm"] -> { localVm: true }`, `["local"] -> { localMac: true }`.
- **`ComputerProviderToggle`** colored per-provider pill, with a
  caption explaining the impact of toggling off (no modal needed just
  to read about the change).
- **`ComputerImpactConfirmModal`** before any disable commit: list
  the bots that would lose a leg of their grant, "Disable Anyway"
  (accent red) and "Cancel" (neutral).
- **`BotComputerMatrix`** row-per-bot table with check-mark chips per
  provider; header carries "Apply new default to all" that opens a
  confirm dialog.
- **`LocalComputerSection` rewrite** at
  `src/components/LocalComputerSection.tsx`: the section's body
  becomes the four provider toggles plus the matrix.  The legacy VM
  runtime setup is preserved in a separate `<LocalVmRuntimeCard>`
  and placed below in the section, so the one-click install / status
  flow operators already use is not silently dropped.
- **`VpsModeToggle`** two-state control next to the VPS row
  (Per-Bot / Not Used), wired to `botDefaults.vpsMode`.  Shared is
  hidden until it has a runtime; see What Shipped, section 4.
- **Persistence** migration in `electron/main.mjs` running once at
  app launch via the existing `updateConfigFile` lock; idempotent
  on already-migrated configs.
- **Tests** in `src/lib/computer-providers.test.ts` covering each
  legacy shape -> new shape, idempotency, the cross-field invariant
  (`vpsMode === null` only legal when `selfHostedVps` is off), the
  state-machine for the toggle-off impact-confirm gate, and the
  matrix's check-mark counts.

## What Shipped

### 1.  Types and Migration (`shared/local-auto-consent.ts`)

- New `ComputerProviderId = "asciiBox" | "selfHostedVps" | "localVm" |
  "localMac"`.
- New `ComputerProviders = Record<ComputerProviderId, boolean>`.
- New `VpsMode = "shared" | "per-bot" | null`.
- New `migrateAllowedComputersToProviders(allowed, vpsMode?)` helper
  that maps every legacy shape onto the new shape, raises if a
  migrated `selfHostedVps: true` would land a `vpsMode === null`,
  and pins `DEFAULT_COMPUTER_PROVIDERS = { asciiBox: true,
  selfHostedVps: true, localVm: true, localMac: true }` plus
  `DEFAULT_VPS_MODE = "per-bot"` for fresh installs.
- New `COMPUTER_PROVIDER_LABEL`, `COMPUTER_PROVIDER_DISABLE_IMPACT`,
  and `COMPUTER_PROVIDER_ORDER` constants so the toggle row, the
  matrix header, and any future tooltip stay in sync from one source.

### 2.  Server Schema and Migration (`server/config.ts`)

- `botDefaultsSchema` now accepts an optional `computerProviders`
  block (each of the four keys optional so a partial save is
  fail-closed) and an optional `vpsMode: "shared" | "per-bot" | null`.
- `AppConfig.botDefaults` mirrors the schema.
- New `migrateComputerProvidersConfig(cfg)` runs once in
  `loadConfig()`: computes the new shape from the legacy
  `allowedComputers` (or from the shipped default for a fresh
  install), repairs the cross-field invariant
  (`vpsMode === null` only legal when `selfHostedVps` is off) in
  place rather than refusing, and returns a boolean so the caller
  can skip the disk write when nothing changed.

### 3.  Client Surface (`src/state/store.tsx`)

- `ConfigStatus.botDefaults` now carries `computerProviders` and
  `vpsMode` alongside the legacy `allowedComputers`.
- Server's `GET /api/config` (`server/index.ts`) returns both
  shapes so the new toggles light up on first paint.

### 4.  New Renderer Components

- `src/components/ComputerProviderToggle.tsx` — colored pill
  (accent green when on, neutral grey when off) with a caption
  underneath explaining the impact of disabling it.  The toggle is
  dumb: the parent owns the enabled state and the dispatch.
- `src/components/VpsModeToggle.tsx` — two-state control
  (Per-Bot / Not Used) with a caption explaining what per-bot
  means on the VPS row.  Shared stays in the `VpsMode` type and
  the config schema but the control hides it until it has a
  runtime; a stored `"shared"` still loads and renders as
  Per-Bot, which is what actually runs.
- `src/components/ComputerImpactConfirmModal.tsx` — modal shell that
  lists the bots that would lose a leg of their grant, "Disable
  Anyway" (accent red unless no bot is affected, in which case the
  button is accent green to read as "commit") and "Cancel" (neutral).
  Keyboard: Escape closes the modal.
- `src/components/BotComputerMatrix.tsx` — row-per-bot table with
  one column per provider.  Cells show a check-mark chip when the
  bot has the provider, otherwise a neutral dash.  The header
  carries an "Apply new default to all" button that opens a
  confirm dialog.

### 5.  Extracted VM Runtime (`src/components/LocalVmRuntimeCard.tsx`)

The Local VM container setup (Steps 1-4: install runtime / start
runtime / prepare Cua Desktop / create VM) plus the per-bot-vs-shared
mode switch were extracted from the old `LocalComputerSection.tsx`
into a new `<LocalVmRuntimeCard>` so the redesigned Computer section
can swap the section's body for provider toggles + matrix without
silently dropping the one-click container install operators rely on.
Behavior is unchanged from the prior file.  Wired into
`SettingsModal.tsx`'s `computers` section below the new
`<LocalComputerSection>` so the order in the panel is: Providers →
Bots → Local VM (runtime) → Bot defaults (legacy compat) → VM runtime
setup details.

### 6.  Rewritten Section (`src/components/LocalComputerSection.tsx`)

The body is now a Providers card (four `<ComputerProviderToggle>`
rows + the `<VpsModeToggle>`) and a Bots card
(`<BotComputerMatrix>`).  State lives in
`state.config.botDefaults.computerProviders`; writes go through
`PUT /api/config` and back-fill the legacy `allowedComputers` from
the new shape so the server's allowlist gate keeps working through
the cut-over.  Disabling a provider opens the impact-confirm modal
when at least one bot currently uses the provider; "Disable Anyway"
commits, "Cancel" restores.  Toggling on is a no-modal commit
(the only impact is that more bots can use the provider from this
point on).  A `resolvedFromLegacy` notice shows when the section
loaded from the legacy key shape and the next save will rewrite it.

### 7.  Desktop Migration (`electron/main.mjs`)

New `migrateComputerProviders({ strict = false } = {})` runs once at
app launch through the same `updateConfigFile` lock used by every
other config migration.  Idempotent on already-migrated configs
(no mtime bump on every boot).  Runs after `secureComposioConfig`
and `secureWorkspaceConfig` so the lock's serializer does not see
the file mutated twice in quick succession on the same launch.

### 8.  Tests (`src/lib/computer-providers.test.ts`)

- migration: each legacy shape (`["cloud"]`, `["vm"]`, `["local"]`,
  multi-element, `null`, `undefined`, empty) -> expected
  `providers` + `vpsMode`
- migration: unrecognized legacy entries are silently ignored
- migration: throws when `selfHostedVps` is on but `vpsMode === null`
- migration: respects an explicit `vpsMode` argument
- constants: every provider id has a label and impact caption; the
  canonical order is pinned
- reducer: toggling off a provider that no bot uses is a no-op
  (no modal)
- reducer: toggling off a provider that some bots use opens the
  impact-confirm gate
- reducer: toggling off a provider does not list bots that have it
  turned off (`computers: []`)
- reducer: toggling on a provider commits immediately, no modal
- reducer: the impact-confirm gate commits the toggle end-to-end
  (state on disk -> next toggle-on is a no-op)
- matrix: `[{ bot: { computers: ["cloud"] } }]` renders 1 check-
  mark, lighting only the resolved cloud backend (`asciiBox`
  when neither the bot nor the workspace sets `cloudBackend`)
- matrix: a bot with `computers: []` renders 0 check-marks
- matrix: a bot with `computers: undefined` (auto) lights the
  resolved cloud backend plus This Computer (the host fallback),
  or the inherited workspace default intersected with the
  provider toggles when a default exists.  The host fallback is
  gated the way the server gates it
  (`shouldMountLocalComputer({ requested: undefined, ... })`):
  macOS hosts only, and only when the bot's engine has a local
  approval channel — Linux/Windows hosts and engines without
  local reach leave the column dark so the matrix and the
  disable-impact modal do not list bots the runtime would never
  mount
- matrix: a bot with `computers: ["local"]` renders `localMac`
  check-mark only

## Verification

- `pnpm typecheck` (renderer + server) passes with no errors.
- `src/lib/computer-providers.test.ts` (NEW): 27 tests pass.
- `shared/local-auto-consent.test.ts`: 5 tests pass.
- `server/config.test.ts`: 115 tests pass (no regression).
- `server/computer-grants.test.ts`: 45 tests pass (no regression).
- `src/state/store.test.ts`: 53 tests pass (no regression).
- `src/components/LocalComputerAutoWarning.test.ts`: 3 tests pass
  (no regression).

## Rollback Plan

1. Revert the PR.
2. `~/.botfleet/config.json` may carry the new `computerProviders`
   and `vpsMode` fields but the legacy `allowedComputers` is
   still written alongside, so an older client renders the old UI
   off the legacy field with no migration needed.  No data loss.
3. The server's `migrateComputerProvidersConfig` is a no-op on
   configs that already have `computerProviders`, so re-deploying
   the previous server does not strip the new fields either.
4. No background jobs, LaunchAgents, or cron rows changed.

## Future Work

- The matrix view's per-cell click handler is intentionally not
  wired; per-bot edits continue to live in each bot's settings.
  A future lane can promote "click a cell to toggle that
  bot's provider" once the UX trade-off (versus the impact-
  confirm modal that would fire for every bot) is settled.
- The legacy `BotComputerDefaults.tsx` "Allowed Computers" card
  duplicates the new Providers card.  It is read-only, so every
  provider disable goes through the Providers card's impact-confirm
  modal.  Once the new section has been the primary view for a
  release, remove the legacy card.
- The new section renders the `resolvedFromLegacy` notice on the
  first paint after upgrade.  That notice should disappear from
  user view once every install has the new shape on disk; the
  notice is left in place as a defensive fallback for hand-edited
  configs.
- The VPS mode picker does not yet differentiate "shared" from
  "per-bot" at the runtime layer; that runtime split is owned by
  a separate lane (see board `660f5bf2`) and should land before
  the new mode picker is documented in user-facing copy.
