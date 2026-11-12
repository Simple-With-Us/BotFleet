# 2026-09-12 — Complete Desktop Release Feed

Seat: CODEX.  Issue #285.  Board `5a2b2e02bf5c4debbc0559d2009032d0`.

## Source Change

The desktop version advances from 1.0.30 to 1.0.31 so an installed 1.0.30 app can discover the next release.  The Release workflow now invokes a dedicated dual-architecture Mac package command; the former “both architectures” step called the arm64-only local package command.

After notarization and stapling, `regenerate-mac-feed.mjs` constructs one deterministic `latest-mac.yml` from the arm64 and x64 ZIP and DMG bytes.  It replaces the duplicate intermediate entries seen in the old local 0.1.38 feed.  The assembly gate validates exact feed versions, artifact names, SHA-512 values, byte sizes, blockmaps, Linux checksums, and stable download aliases across all three desktop platforms.

The default workflow run is artifact-only.  It keeps read-only repository permissions, preserves the verified release set as a private Actions artifact, and cannot create or edit a GitHub Release.  Draft and publish are explicit inputs handled by a separate `contents: write` job.  That job uses GitHub's short-lived repository token, pins a new tag to the prepared source SHA, refuses an existing published release or a draft aimed at another SHA, peels existing lightweight or annotated tags and rejects a mismatched source commit before any release mutation, serializes mutation per version, removes stale draft assets, and downloads the uploaded bytes for another complete verification before optional publication.

## Evidence And Remaining Acceptance

The public release `v0.1.38` was re-read on September 12 and contains only four DMGs.  Release run `33822154040` built Windows and Linux but failed while importing empty Mac certificate values, before Mac artifacts or assembly.  GitHub's secret-name list now contains the three Apple notarization values but still omits `MAC_CERT_P12_BASE64` and `MAC_CERT_PASSWORD`; the automation can also source that pair from Infisical, whose current values were not inspected.

Focused fixture tests cover a complete release, post-feed artifact tampering, stale stable aliases, and deterministic removal of duplicate Mac feed entries.  `actionlint` validates the workflow.  A signed, notarized artifact-only run remains the next credential-bearing check.  Creating or publishing `v1.0.31`, then checking, downloading, verifying, and installing it on an approved device remain root-owned actions; this source lane performs none of them.

## September 12 Follow-up

Artifact-only run `34686539553` built Windows and Linux, then failed at Mac certificate loading because both `MAC_CERT_P12_BASE64` and `MAC_CERT_PASSWORD` were absent after the Infisical production export and GitHub fallback.  Assembly and release mutation were skipped.  No draft or public release was created.  Local Developer ID signing is available; that does not repair the hosted signing inputs or establish notarization.

Six release regression tests and actionlint pass, including a pre-existing lightweight tag aimed at the wrong commit, nested annotated tags, and fail-closed authentication, rate-limit, and malformed-chain responses.  Typecheck and four CI-scope tests also passed after merging current main.  The repository's on-demand release validation helpers are registered in the Mac process inventory and its pinned Coding note; no daemon was added.

A further review found that blockmap presence alone did not establish correctness.  The verifier now checks each gzip v2 map's complete coverage and BLAKE2b-144 chunk hashes against its installer, using Python's standard library.  Eight release tests cover corruption, a stale map copied from another artifact, and a multi-chunk map emitted by the installed Electron packager.  No package installation is needed in the assembly/release validation jobs.

## Hosted Signing And Linux Feed Correction

The existing Developer ID was exported through the macOS Keychain authorization prompt, matched to the expected signing identity, and stored in the existing BotFleet production Infisical vault as the two missing Mac certificate inputs.  Exact readback succeeded without exposing values or duplicating them in GitHub secrets.  Run `34686539553` attempt 2 then passed signing, notarization, and stapling for both Mac architectures, plus the Windows and Linux packaging jobs.  Its original source remains `0f01581b`; this is signing-path evidence, not acceptance of the later merged source or an installed Mac update.

Assembly refused publication because the generated `latest-linux.yml` contains both the AppImage and Debian package, while the strict verifier expected only AppImage.  The verifier now requires and hashes both entries.  The regression fixture mirrors that observed two-entry feed and rejects a missing Debian entry or Debian bytes changed after feed generation.  Nine focused release tests pass; full repository and final hosted assembly acceptance remain pending.  No draft or public release was created by the failed artifact-only run.

The on-demand release-validation row and pinned Background Jobs Master List note were refreshed with the successful signing boundary and this follow-up.  Final current-source packaging, publication, and installed-device verification remain open in #285.
