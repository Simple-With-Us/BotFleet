# 2026-09-12 — iOS Bot Profile Save Failure

Issue #293.  Board `f16194b9`.  Branch `codex/ios-bot-save-error-20260912`.

## Behavior

The bot profile editor now dismisses only after `Session.updateProfile` returns the saved bot.  Offline, validation, conflict, and server failures already return `nil` and publish the actionable error through `Session.actionError`; the editor now stays open with the person’s form values intact so Save can be retried.

The save task also uses `defer` to restore its busy state on both success and failure.  The successful path still synchronizes the form and baseline from the server response before dismissing.

## Validation

- Focused `ProfileSaveGateTests` verify that failure preserves the draft and suppresses dismissal, while success applies the server-confirmed value and permits dismissal.  The implementation matches the established successful-save contract used by `GroupProfileView`.
- Focused Swift tests and hosted unsigned iOS compilation are required before merge.
- Simulator screenshot and physical-device offline, validation, conflict, retry, and successful-save acceptance remain open because this Mac has no installed iOS runtime or paired test device.  No live pairing or profile state was mutated.
