# Placement Rollback Bridge And Artifact Proof

Refs BF-2632, BF-2625 and BF-2544.  This unit builds a conservative read-only rollback runtime, with a separate future artifact probe.  No retained production artifact has been inspected, no production ledger has been migrated, and all sixteen placement acceptance flags remain false.

## Existing Boundaries

The production bridge bootstrap retains the existing epoch-aware behavior for ordinary JSON.  A UUID marker instead selects a separate strictly read-only SQLite controller reader and an immutable process capability that refuses execution.  It constructs no normalized lease writer or payload spool, performs no prepared activation, and exposes no migration API or environment switch.  The forward SQLite writer remains available only through its explicit module interface for isolated fixtures and later reviewed activation work.  A strict older JSON reader rejects the marker, so migration before retaining a compatible rollback build would remove the existing recovery path.

The read-only connection uses SQLite WAL visibility and shared locking, never an immutable URI that could ignore committed WAL.  It issues no journal-mode, checkpoint or other modifying PRAGMA.  SQLite may maintain its shared-memory coordination sidecar; that is distinct from writing the authoritative database, WAL or marker.  Every identity read verifies private owned regular single-link files, UUID/schema/active-phase binding, a consistent read snapshot and a non-regressing fence.  Missing, corrupt, prepared, replaced or unknown authority fails closed.

Every placement POST is denied, including registration, heartbeat and an identical terminal report.  Owner/platform authorization still precedes identity reads.  Runtime quiesce, drain, force, lease expiry and DELETE cannot lift the immutable execution capability or claim existing work.  Existing unfenced local jobs remain observable but cannot be adopted, settled, pruned, stopped or relaunched by this build.

| Entry Point | Bridge Behavior |
| --- | --- |
| JobRegistry construction, queue, timers, adoption and shutdown | Passive record reads; no spool reconciliation, spawn, process scan, signal or record write |
| Central one-to-one and separate room turn paths | Refuse before touching dispatch state |
| Scheduler and resource-trigger admissions | Refuse before new work; passive scheduler construction preserves interrupted runs/check-ins |
| Interrupted-turn, process-group and held-work startup recovery | Preserve evidence; no consumption, adoption or automatic resumption |
| Pending update resume and updater release | Preserve saved work; no requeue and no release of the capability |
| Mutating application API | Refuse, except owner-authenticated updater checks/run and lifecycle diagnostics |
| Placement identity | Fresh authorized read-only controller snapshot |

The release manifest in `scripts/harness-release-store.mjs` accepts only its existing version, commit, promotion time, Node and platform fields.  Adding a capability field would make older strict readers reject it.  `electron/runtime-identity.mjs` proves app/API/build provenance and the static UI identity; it does not establish placement-schema compatibility.  Neither a green build nor a caller-supplied compatibility boolean is an artifact proof.

The existing updater keeps physical rollback generations and verified receipts, but a future prune can replace the generation a prior probe inspected.  Proof therefore needs an immutable artifact binding and a retention recheck at the later activation boundary.  The existing application-update, harness-ownership and rollback stop/resume contracts remain authoritative; this unit introduces no new live lock, service, secret, provider or transport.

## Probe Inputs And Result

Use one explicitly selected retained artifact, its expected source commit and its actual shipped runtime.  Do not scan a user's data directory, credential stores or arbitrary installed applications to discover candidates.  Resolve the artifact through the existing retained-release or signed-bundle rules, and bind the physical candidate and runtime to their verified provenance and content inventory.  Internal framework aliases must follow the existing bundle validation contract rather than an invented recursive hash that follows arbitrary links.

The proposed source entry point is `inspectPlacementRollbackCandidate(candidate)`.  Static inspection can return only `blocked` or `probe-required`.  A separate controlled fixture runner may return `fixture-verified` after it actually exercises that same immutable candidate/runtime pair.  Every result retains `activationAllowed: false` in this unit.  No externally supplied report can mint a verified result without the verifier recomputing the artifact binding and obtaining its own probe evidence.

Keep the proof receipt separate from the strict release manifest.  It identifies the selected physical release, source commit, clean build identity, artifact and runtime fingerprints, normalized schema identifier, fixture recipe version, outcomes and logs.  Those fields describe evidence; they grant no authority to migrate, enable modes, update authentication or prune another rollback generation.

## Isolated Runtime Recipe

Run against a new temporary home, free loopback ports, container lockdown and one unknown provider driver.  Never copy live user data or run a provider request.  Use the actual candidate runtime, including its existing Electron-as-Node launch mode when applicable, so a current development Node cannot conceal a shipped runtime that lacks `node:sqlite` support.

First boot with a strict legacy epoch fixture and prove the pair remains rollback-readable and no SQLite authority or payload namespace is created.  Then stop the fixture completely and prepare a separate normalized fixture through the already reviewed explicit migration helper.  The prepared fixture contains a nonzero controller fence, reconciliation state, a settled report, an unreachable old issuing lease with a pending stop, and a released lease tombstone.  No executable payload is needed.

Boot the retained candidate against that fixture and use existing owner-bound routes only.  Identity must report the stored fence and converge on a later committed fence without restarting the bridge.  Every placement POST must refuse without allocation or acknowledgement, including terminal report replay, released-lease dispatch, stale requests, registration and heartbeat.  Verify job/scheduler/startup recovery stays passive, updater release cannot remove the hold, and saved resumption evidence remains intact.  The canonical logical ledger digest and authoritative database/WAL/marker bytes must remain unchanged unless the fixture writer deliberately commits a newer fence.

Stop the fixture child with the existing bounded process-tree cleanup and verify it is gone.  Recheck artifact/runtime fingerprints after execution, preserve logs and verify that no command nonce or spawn receipt was produced.  A source-only strict JSON reader is a negative fixture, not evidence that the actual retained legacy artifact was tested.  Missing artifacts, dirty or mismatched provenance, unsupported runtime, changed files, malformed marker/database, changed ledger digest or an incomplete child teardown produce `blocked`.

## Retention And Later Activation

The bridge release must first be built, verified and retained while production remains on legacy JSON.  A later reviewed activation unit must select and protect a compatible retained generation, revalidate the same source/artifact/runtime binding, verify that the old volatile placement book is settled, and hold the existing ownership/update boundaries before replacing any production JSON marker.  A receipt that once passed but no longer names the retained bytes cannot satisfy that gate.

Activation and rollback are separate from this read-only probe.  Rollback after migration preserves the full data directory and selects a compatible bridge artifact; it never resets the epoch, deletes the UUID marker, restores an old ledger backup or falls through to an incompatible binary.  The exact pruning pin and activation operation remain future integration work until the actual source/artifact proof exists.

## Source Work And Verification

The actual bridge source and isolated source-runtime fixtures come first.  An invariant review must inspect its admission paths before its full gate.  A separate built-in-only static inspector and selected-artifact probe must later reuse existing build-identity, release-manifest, runtime selection and process cleanup contracts.  They need missing/mismatched/dirty identity, changed runtime or artifact bytes, strict-old-reader refusal, normalized fixture success, stale and released-lease refusals, unchanged logical state, retained-generation replacement and failed child cleanup coverage.

Tests may execute only generated fixture candidates or explicitly authorized build outputs in temporary stores.  They must not label a generated fixture as a shipped-runtime pass.  Mac signature and packaged-runtime checks require the supported platform and selected artifact; unavailable capability remains a concrete missing proof, not a reason to change credentials, create a tunnel or enable activation.
