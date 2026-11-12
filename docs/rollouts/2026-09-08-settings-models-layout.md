# 2026-09-08 — Settings Models Layout

**Why:** Jay's screenshot (via Designer) showed Settings > Models too small for
fleet rows.  Model pills overlapped, and iOS squeezed the fallback control
beside the primary instead of stacking it.

**What landed**

- Desktop Settings dialog grows from 860×560 to 1100×720 (about 28 percent)
  and still shrinks to the viewport.
- Fleet model rows wrap Primary, fallbacks, and Add Fallback as chips instead
  of a four-column grid, so pills do not overlap.
- Contained model pills (no side label) fill their chip and truncate inside it.
- Changing Primary keeps that bot's fallbacks.
- Controls are Title Case.  Exterior copy uses two ASCII spaces (NBSP+space
  in JSX).  No developer-speak ("slot", "engine") on this surface.
- iOS Bot Profile: Primary Model is its own section.  Each fallback is a
  section stacked below, with navigation-link pickers on their own rows.
  Extra-ship no.  No TestFlight.

**Verify**

- `pnpm typecheck`
- `pnpm exec vitest run src/lib/ui-copy.test.ts`
- `pnpm test`
- `cd ios && swift test`
- unsigned `xcodebuild` for iPhone simulator (no TestFlight)

**Board:** `991b22a3`.  **Branch:** `grok/settings-models-layout`.
