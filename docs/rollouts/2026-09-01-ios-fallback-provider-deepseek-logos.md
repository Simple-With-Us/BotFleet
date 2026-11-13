# Rollout: iOS Fallback Provider Dropdowns, DeepSeek Harness & Logos

**Date:** 2026-09-01  
**Author:** Antigravity (`AG`)  
**Branch:** `ag/ios-fallback-provider-deepseek-logos`  
**Status:** Completed & Tested

---

## 1. Summary

1. **iOS Fallback Provider & Model Pickers:** In `ios/App/AgentProfileView.swift`, enabled full Provider and Model dropdown pickers for each fallback model row (matching primary model flexibility), allowing iOS users to pick different model providers across their fallback chain.
2. **DeepSeek Harness (`dsh`) GUI Discovery:** Set `authFailure: "continue"` in `server/drivers/acp/dsh.ts` and extended credential detection so the DeepSeek harness is discoverable in the GUI model catalog without requiring manual setup first.
3. **Official Blue DeepSeek Whale Logo:** Updated `src/components/ProviderIcons.tsx` so both `dsh` and `dshAgent` use the official blue DeepSeek whale logo (`fill-blue-500 dark:fill-blue-400`).
4. **Antigravity Logo Separation:** Corrected `src/components/ProviderIcons.tsx` to render `<AntigravityMark />` (official Google Antigravity mark) for Antigravity, keeping `<GeminiMark />` dedicated to Google Gemini.

---

## 2. Verification

- `swift test --package-path ios` — **Passed (187/187 tests)**
- `pnpm typecheck` — **Passed (0 errors)**
- `pnpm build` — **Passed (0 errors)**
