# Rollout — antigravity-usage N/A remaining is exhausted

**Why:** Owner 2026-09-04: Gemini is fully exhausted.  `antigravity-usage` prints N/A when `remainingPercentage` is omitted.  That means none remains, not "unknown".  PR #187 skipped only `isExhausted` or remaining 0, so Gemini stayed routable.

**Fix:** Missing remaining on a turn model is a cap until `resetTime`.  Autocomplete-only rows stay ignored.

**Verify:** `pnpm exec vitest run server/antigravity-quota.test.ts`
