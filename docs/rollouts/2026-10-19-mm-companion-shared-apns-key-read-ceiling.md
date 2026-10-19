# BotFleet Companion: The Shared APNs Key Was Not Being Read

## Summary

AFC-359 (PR #1259) moved the Companion sidecar's APNs signing key off a
hardcoded, now-revoked key id and onto the fleet's shared key in Infisical
(`APNS_KEY_P8` and `APNS_KEY_ID`, key id `HSJ98QN95V`).  That change was
correct, reviewed and merged.

It could not actually work, for two reasons that neither the diff nor the code
showed:

1.  **The live runtime was 116 commits behind.**  `~/apps/botfleet-companion` is
    a detached worktree of this repo, and it still sat at `1571048b3` — the
    pre-AFC-359 code, with the revoked `N3949G7CN6` default baked into
    `companion/src/apns.ts`.  The sidecar that runs on the Mac is that
    checkout, so the merge changed the repository and not the runtime.  It was
    re-pointed to `origin/main` (`986736669`) on 2026-10-19.

2.  **The read was capped below the vault's own latency.**  `fleet-secrets get`
    takes 3.6-5.3 s warm and 16.6 s with a cold cache on the fleet Mac.  The
    read ceiling in `fleetSecretsGet` was 10 s, so a cold read was killed by
    `execFileSync` and the `catch` turned it into `null` — which the sidecar
    reads as "no key", which turns APNs pushes OFF.  The key was present, the
    vault was answering, and the pushes stayed dark anyway.

This change lifts the ceiling to three times the measured worst case and makes
it overridable, so a slow vault can no longer silently switch the sidecar's
pushes off.

## Decisions

-  **Derive the ceiling from the measurement, and assert the ordering.**  The
    budget (`APNS_VAULT_READ_BUDGET_MS`, 16.6 s cold) and the ceiling
    (`APNS_VAULT_READ_TIMEOUT_MS`, three times it) are two names for one
    number, and a test asserts the ceiling stays at or above twice the
    budget.  A guard whose threshold drifts below its subject does not
    announce itself:  nothing throws, it just stops guarding.

-  **Only a finite, positive override is honoured.**  `Number("-1")` is a
    number, so `Number(env) || default` would let a negative override become
    an instant timeout — the same "no key" failure, through the new door.
    `0`, `-1`, `-5000`, `not-a-number` and `""` all fall back to the default.

-  **Fail towards "pushes on", not "pushes off".**  The sidecar's behaviour on
    a missing key predates this change and is right:  a key it cannot read is
    not a key it should sign with.  The fix is therefore to make the read
    succeed, not to make the failure louder.

-  **The old code failed closed, and that was correct.**  The pre-AFC-359
    runtime logged `APNs pushes stay off — Apple refused this signing key
    (InvalidProviderToken)` and refused to keep hammering Apple.  It named the
    wrong remedy — replace the key file — but it did not make a bad situation
    worse, and it is why this went unnoticed rather than noisy.

-  **Did not touch the retired `~/.secrets` copies.**  The shared key lives in
    Infisical and is read through `fleet-secrets` at runtime, so the staged
    `~/.secrets/AuthKey_*.p8` files are no longer load-bearing for this path.

## Files

-  `companion/src/apns.ts` — `APNS_VAULT_READ_BUDGET_MS`,
    `APNS_VAULT_READ_TIMEOUT_MS`, `vaultReadTimeoutMs()`, and the ceiling
    `fleetSecretsGet` uses.
-  `companion/src/apns.test.ts` — the ordering invariant, the override, and
    the refusal of a non-positive override.

## Verification

-  `pnpm vitest run companion/src/apns.test.ts` — 133 passed (1 file), before
    and after the change.
-  `pnpm typecheck` — clean.
-  Credential probe against the live Apple endpoint, using the lane's own
    `loadApnsConfig()`:  the sidecar resolved `keyId HSJ98QN95V` from
    `Infisical APNS_KEY_P8`, signed a provider token, and Apple answered
    **400 BadDeviceToken** for a non-existent device.  A refused key answers
    403 `InvalidProviderToken`; 400 is authentication succeeding and the
    device being unknown.  Nothing was delivered — the probe uses 64 zeroes.

## Next steps

-  The Mac runtime is deliberately parked:  `launchctl print-disabled
    gui/501` lists `app.botfleet.companion` and `app.botfleet.server` as
    disabled, and `mac-process-watch` logs `SKIP launchd:app.botfleet.server
    disabled`.  Do not bootstrap them without the owner.
-  When the owner re-enables the companion, re-point the runtime checkout to
    `origin/main` again and confirm the log line `Infisical APNS_KEY_P8`
    instead of the revoked-key path.
-  Still unconfirmed anywhere in the fleet:  a push that actually lands on a
    phone.  Every check so far is credential-level.
