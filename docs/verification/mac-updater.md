# Mac updater transaction

The Mac updater fixture simulates signed update delivery, application, and transaction rollback using the updater's test harness without modifying the user's installed app.

## Setup

```sh
node scripts/mac-update-transaction.node-test.mjs
```

This test:

1. Stages a signed update package (DMG or ZIP)
2. Simulates the updater CLI parsing the feed
3. Verifies signature and notarization
4. Applies the update in a temporary directory
5. Rolls back on error and confirms no partial state remains

## Steps

```sh
# 1. Run the updater transaction test
node scripts/mac-update-transaction.node-test.mjs

# 2. Expected output:
# - "Verifying signature…" with success
# - "Applying update…" with staging directory
# - "Transaction committed" on success
# - Clean rollback on simulated error
```

## Expected Evidence

A passing run shows:

- **Output:** Transaction log showing each phase (verify, apply, commit)
- **No partial state:** Rollback removes all temporary files on error
- **Signature verification:** The updater confirms the package was signed by the expected developer identity
- **Version jump:** Update correctly advances from v1.0.30 to v1.0.31 (or configured versions)

## Key Behaviors Verified

- **Signature validation:** The update package is signed with the Developer ID certificate
- **Notarization check:** Stapled notarization ticket is validated
- **Atomic apply:** Update is staged in a temporary directory before final commit
- **Rollback on error:** Any failure during apply rolls back completely; no partial state remains
- **User experience:** User sees "Check for updates" progress and update-applied confirmation

## Important Notes

Creating or publishing a release, then checking, downloading, verifying, and installing it on a real device remain owner-only actions.  This test verifies the updater's transaction logic in isolation; end-to-end installation is tested separately on approved devices.

## Cleanup

The test removes its staging directories.  No manual cleanup is needed.
