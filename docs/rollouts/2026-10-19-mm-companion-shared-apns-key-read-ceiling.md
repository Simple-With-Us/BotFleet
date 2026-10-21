# BotFleet Companion: The Shared APNs Key Was Not Being Read

## Summary

AFC-359 (PR #1259) moved the Companion sidecar's APNs signing key off a
hardcoded, now-revoked key id and onto the fleet's shared key in Infisical
(`APNS_KEY_P8` and `APNS_KEY_ID`, key id `HSJ98QN95V`).  That change was
correct, reviewed and merged.

It could not actually work, for two reasons that neither the diff nor the code
showed:

1.  **The live runtime was 116 commits behind.**  The companion's live
    checkout is a detached worktree of this repo, and it still sat at
    `1571048b3` — the pre-AFC-359 code, with the revoked `N3949G7CN6` default
    baked into `companion/src/apns.ts`.  The sidecar that runs on the Mac is
    that checkout, so the merge changed the repository and not the runtime.  It
    was re-pointed to `origin/main` (`986736669`) on 2026-10-19.

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

-  **A read ceiling is a claim about latency, and a synchronous read spends
    that claim on the event loop.**  Widening the ceiling to survive a slow
    vault is only safe if the read is asynchronous:  otherwise the ceiling is
    also the time the sidecar is deaf, and widening it from 10 s to 49.8 s
    made a stall five times longer rather than shorter.  The read is async
    now, one read runs at a time however many callers miss the cache
    together, and the same `timeout` still bounds it — a killed read is
    still a failed read, which is what turns APNs pushes off.

-  **Only a finite, positive override is honoured.**  `Number("-1")` is a
    number, so `Number(env) || default` would let a negative override become
    an instant timeout — the same "no key" failure, through the new door.
    `0`, `-1`, `-5000`, `not-a-number` and `""` all fall back to the default.

-  **A test that depends on who is faster is not a test.**  The narrowed
    ceiling test asserted that a 1 ms ceiling kills a read, and it proved that
    by racing the fake against the clock.  On a slow fork the fake lost and
    the test passed;  on the CI runner's fast fork the fake answered inside
    the ceiling, the read succeeded, and the test failed.  The fix is not to
    make the fake slower on purpose but to make it deterministically slower
    than the ceiling, so the outcome is the same on every machine.  A test
    that can only pass on a slow machine is a test that will fail in CI.

-  **Stamp the cache entry when the whole read finishes, not when its first
    half does.**  The key id is a second read, and the raised ceiling allows
    that read to outlive the retry window.  An entry stamped before the id
    read was already expired by the time it was written, so the next caller
    paid for a second full vault round trip — the exact cost the completion
    stamp was introduced to remove.  The stamp belongs to the read, not to
    the PEM half of it.

-  **Fail towards "pushes on", not "pushes off".**  The sidecar's behaviour on
    a missing key predates this change and is right:  a key it cannot read is
    not a key it should sign with.  The fix is therefore to make the read
    succeed, not to make the failure louder.

-  **The old code failed closed, and that was correct.**  The pre-AFC-359
    runtime logged `APNs pushes stay off — Apple refused this signing key
    (InvalidProviderToken)` and refused to keep hammering Apple.  It named the
    wrong remedy — replace the key file — but it did not make a bad situation
    worse, and it is why this went unnoticed rather than noisy.

-  **Did not touch the retired secrets folder.**  The shared key lives in
    Infisical and is read through `fleet-secrets` at runtime, so the staged
    `AuthKey_*.p8` copies are no longer load-bearing for this path.

## Review findings

Thirteen review findings across four rounds, all in the same shape as the bug
it was fixing:  a value that looked fine and silently removed the key, a
change that looked safe and stopped the sidecar answering, or a mask that
looked masked and printed the key.

1.  **The failure cache was stamped when the read STARTED.**  `readVault`
    captured `now` before the subprocess ran and stored that in the cache
    entry.  A read that takes longer than the retry window therefore left an
    already-expired entry behind, and the next caller ran another full read —
    `refreshConfig` asks for the key stamp and then the key config, so one
    refresh could block for nearly 100 s.  The entry is now stamped when the
    read finishes, so the read's own duration never counts against the retry
    window.  The regression test fails on the old stamping with two vault
    reads where there should be one.

2.  **A fractional read ceiling threw instead of timing out.**  The override
    accepted any finite positive number, and Node's `execFile` rejects a
    fractional timeout with `ERR_OUT_OF_RANGE`.  The read threw, the catch
    swallowed it, and the key vanished — the exact "no key" outcome the
    ceiling exists to prevent.  Both knobs now go through one
    `positiveIntegerEnv` helper that honours only a finite, positive integer.

3.  **Raising the ceiling made the event-loop stall five times worse.**  The
    read was synchronous, so the ceiling was also the length of time the
    sidecar could not answer a request, fire a timer, or drain a push queue.
    A 10 s ceiling became 49.8 s, and a cold start needs two reads in
    sequence — nearly 100 s of a frozen event loop, on the path that decides
    whether a phone gets woken at all.  The read is now asynchronous, with the
    same `timeout` still killing the child at the ceiling, so the read is
    bounded without the loop being held.  A test fires a timer while the vault
    is answering and fails against the synchronous read.

4.  **The completion stamp was taken before the key-id read.**  `readVault`
    stamps the entry when the PEM read finishes, but the key id is a second
    read, and the raised ceiling allows that read to take longer than the
    retry window.  An entry stamped before the id read was already expired by
    the time it was written, so the next caller ran a second full vault round
    trip instead of taking the cached answer.  The stamp is now taken when
    the whole read finishes.  The new regression test fails against the old
    stamping with four vault reads where there should be two.

5.  **A refused key was named by its source, not by a masked preview.**  The
    persisted-fault warning said which store held the key, but not which key
    it was.  Rule 43 requires a rejected provider key to be identified by a
    masked first-8/last-4 preview, so the operator can tell one bad key from
    another without the key ever being printed.  `keyPreview()` strips the PEM
    armour and returns `xxxx…yyyy`, and the warning carries it.  A test
    asserts the preview is present and the key material is not.

6.  **A timing-dependent test passed on a Mac and failed in CI.**  The
    narrowed-ceiling test relied on the fake vault being slower than a 1 ms
    ceiling, which is true on a slow fork and false on a fast one:  the CI
    runner answered inside the ceiling, so the read succeeded and the test
    failed.  A test that depends on who is faster is not a test.  The fake now
    waits, so the ceiling always wins, and the outcome is the same on every
    machine.

7.  **The mask degenerated and printed the whole key for a short one.**
    `keyPreview()` takes the first eight and the last four characters of the
    material, and a material of twelve characters or fewer is COVERED by
    those two slices — they hand back every character of the key, just in
    two halves — so the "masked" preview of `ABCDEFGH` was
    `ABCDEFGH…EFGH`, the whole key.  A preview that prints the secret it
    exists to hide is worse than no preview, so a material that short now
    previews as `unavailable`.  The guard is written as the mask's own width
    (`8 + 4`) rather than as a copied total, so a later edit cannot drift
    away from it.  The new test fails against the old mask with the full key
    in the received value.

8.  **The live refusal named no key at all.**  The persisted-fault warning
    carries the masked preview, but the line printed the moment Apple refuses
    the key — the common case — carried only Apple's reason string, so an
    operator could not tell which key was rejected.  The live warning now
    carries the same masked preview.  The new test fails against the old
    warning with no preview in the received line.

9.  **A new test left `console.warn` mocked for the rest of the file.**  The
    spy was installed and never restored, so every later test in the file ran
    with the sidecar's warnings silenced.  The `finally` block now restores it,
    matching the sibling tests in the same file.

10.  **The short-material test never exercised the warning path it claimed
    to check.**  It asserted on `keyPreview()` alone, so a warning that
    printed the key material directly would still have passed it, and its
    last assertion re-checked a value already asserted on the line above.
    The test now drives the refused-key warning with an eight-character key
    and asserts the warning says `unavailable` and never carries the
    material.

11.  **The live refusal named a remedy that no longer exists.**  The warning
    said pushes are off "until the key file changes", but the key lives in
    the vault and the fault clears only when the vault secret changes:  an
    operator was pointed at a local `.p8` that is no longer read, and
    replacing it would not have turned pushes back on.  The warning now
    names the source, the same way the persisted-fault message does.

12.  **The guard's stated rationale misstated why twelve characters are
    refused.**  The comment said the two slices overlap at twelve or fewer,
    but at exactly twelve they are adjacent, not overlapping;  the reason the
    key is refused is that the mask COVERS it.  A maintainer who "corrected"
    the bound to `<` on the strength of the overlap story would have
    re-opened the full-key echo the guard exists to close.  The rule is now
    stated as coverage, and the bound is the mask's own width (`8 + 4`)
    rather than a copied total.

13.  **The whole file described the signing key as a file on disk.**  Finding
    11 was one line, but the same stale framing ran through the status
    reason, the persistence preamble, the fault-store doc, the refresh doc
    and half a dozen comments — and one recovery log line told the operator
    "the APNs key file changed" when what changed was the vault secret.
    Every one of them now says "the signing key", so the next reader is not
    sent to a file that is not read.

## Files

-  `companion/src/apns.ts` — `APNS_VAULT_READ_BUDGET_MS`,
    `APNS_VAULT_READ_TIMEOUT_MS`, `positiveIntegerEnv()`, `vaultReadTimeoutMs()`,
    `vaultRetryMs()`, the completion stamp in `readVault`, the asynchronous
    `fleetSecretsGet()` with its in-flight guard, and the generation counter
    that keeps a cleared cache from being written back by a read already in
    flight.  `keyPreview()` masks a rejected key for both the persisted-fault
    and the live refusal warning, refuses to preview a material too short to
    mask, and expresses that bound as the mask's own width.  The live
    refusal names the key's source as the remedy.
-  `companion/src/apns.test.ts` — the ordering invariant, the override, the
    refusal of a non-positive or fractional override, the slow-failed-read
    regression, the event-loop regression, the concurrent-read guard, the
    slow-key-id-read regression, the masked-preview assertions for both
    warnings, the short-material refusal, the test that drives the
    refused-key warning with a short key, and the narrowed-ceiling test that
    no longer depends on who is faster.

## Verification

-  `pnpm vitest run companion/src/apns.test.ts` — 143 passed (1 file).
-  `pnpm typecheck` — clean (exit 0).
-  `pnpm lint` — baseline check passed;  4876 warnings against a baseline of
    4884, so eight fewer than the baseline allows.
-  The slow-failed-read regression test was run against the old stamping and
    fails there (`expected [ Array(2) ] to have a length of 1 but got 2`), so
    it tests the defect and not the new code.
-  The slow-key-id-read regression test was run against the old stamping and
    fails there (four vault reads where there should be two), so it tests the
    defect and not the new code.
-  The short-material test was run against the old mask and fails there
    (`expected "ABCDEFGH…EFGH" to be "unavailable"`), so it tests the defect
    and not the new code.
-  The live-refusal test was run against the old warning and fails there
    (`expected "companion: APNs refused the signing key (InvalidProviderToken);
    pushes are off until the key file changes" to contain "MIGHAgEA…BeVr"`), so
    it tests the defect and not the new code.
-  The live-refusal test was run against the old remedy text and fails there
    (`expected "companion: APNs refused the signing k…" to contain
    "Infisical APNS_KEY_P8"`), so it tests the remedy and not the new code.
-  The short-material warning test was run against a live-refusal line that
    prints the material directly and fails there (`expected "companion: APNs
    refused the signing k…" not to contain "ABCDEFGH"`), so it tests the
    material leak and not the new code.
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
