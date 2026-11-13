# Rollout: iOS Activity Run Grouping & Work Summary Cards

**Date:** 2026-09-02  
**Author:** Antigravity (`AG`)  
**Status:** Completed & Verified  
**Tests:** 203/203 Swift Tests Passing, Typecheck Clean, Vite Build Clean

---

## 1. Summary

Fixes the issue where long chains of consecutive tool activity messages flooded the iOS chat screen as dozens of individual repetitive rows (e.g. 15+ standalone `run_command • Success` rows without context).

Now:
1. **Folded Activity Run Summary Card:** Consecutive tool activities are automatically folded into a single, compact, interactive **Work Summary Card** (`ActivityRunView`).
2. **Dynamic Work Summary:** The collapsed card displays:
   - Status badge and icon (`wrench.and.screwdriver.fill` / spinner if in-progress / error triangle if failed)
   - Step count: e.g. **`14 tool calls • Complete`**
   - High-level tool summary: e.g. `run_command ×10, view_file, call_mcp_tool`
   - A `Details` disclosure button.
3. **Expand on Tap:** Tapping the card smoothly expands in-place to reveal all individual `SkillExecutionReceiptView` receipts with detailed tool inputs, parameters, and outputs.
4. **Auto-Expansion on Error:** If any step fails during the run, the card automatically opens to surface the error immediately.

---

## 2. Key Code Changes

- **`ios/Sources/CompanionCore/ActivityRuns.swift`:** Added `TranscriptItem` enum (`.message` vs `.run`), `groupActivityRuns`, and `describeActivityRun` to fold consecutive tool activities.
- **`ios/Tests/CompanionCoreTests/ActivityRunsTests.swift`:** Added comprehensive test suite for single tools, multi-tool folding, run breaks on text messages, and descriptor formatting.
- **`ios/App/ChatView.swift`:** Updated `transcriptColumn`, `startsANewStretch`, and `endsRun` to render `[TranscriptItem]` with `ActivityRunView`.

---

## 3. Verification

- `swift test --package-path ios` — **Passed (203/203 tests)**
- `pnpm typecheck` — **Passed (0 errors)**
- `pnpm build` — **Passed (0 errors)**
