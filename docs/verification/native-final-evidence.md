# Native Final Evidence Bundle

BF-2630 makes the Phase 6 deletion CLI require a private receipt bundle in addition to its existing issue-state and evidence prerequisites.

The offline checker verifies exact byte hashes, candidate identity, receipt structure, required command results, linked artifacts, interval coverage and consistency.

It does **not** authenticate the runner or owner, establish that a command or observation actually happened, establish that a log is complete or truthful, or grant installation, retirement or deletion permission.

Source tests and CI use explicitly synthetic temporary fixtures; they are never production receipts, elapsed acceptance or owner approval.

## Candidate And File Binding

`scripts/decommission-evidence-bundle.mjs` exports the strict version 1 schemas and the required receipt/check lists.

A bundle pins the exact 40-character source SHA, 12-digit shared build number, 64-character signed artifact SHA-256, placement mode, distinct Mac/server host identities and roles, expected engine inventory and acceptance owner.

Each receipt repeats the same candidate, mode and host binding and supplies its runner, capture instant, traceable HTTPS source and hashed original provenance capture.

Every reference contains a relative bundle path and SHA-256 of the exact redacted bytes, including the gate state, each receipt, every command result artifact and every observation log.

The final CLI also requires the candidate identity separately on its command line, so a self-consistent packet for another candidate cannot pass accidentally.

The bundle directory and its files must belong to the executing account, with no group or other access; use `0700` directories and `0600` files.

Reads refuse symlinks, hard links, traversal, absolute artifact paths, changed inode/metadata, files over 1 MiB, more than 128 files and over 16 MiB of captured bytes.

These are evidence-container bounds, not product resource budgets.

The reader snapshots each accepted file once and passes verified bytes to dependent checks, including the existing placement recipe/artifact validator; it does not reopen unbounded artifacts after hashing.

POSIX ownership is required; hosts unable to prove it refuse the final check.

## Required Receipts

| Receipt | Required Evidence |
| --- | --- |
| `placement` | Existing sixteen-recipe manifest, both host inventories and hand-run logs; every referenced artifact is hash-bound and checked through the actual placement artifact validator. |
| `import` | Final parity and the read-only archive. |
| `replay` | One passing ordered replay result for each explicitly inventoried engine. |
| `rollback` | Restore rehearsal and restored health. |
| `signed-release` | Signing, notarization, stapling, one installed native copy, exact Open on Mac target, companion operation without Electron, and an installed previous build updating through the native feed; bundle identifier, Team ID, designated requirement and distinct previous build are recorded. |
| `linux-retention` | Pinned maintained and rollback source refs, a hashed closure manifest, clean-export build, install/start, update and rollback results. |
| `process-inventory` | Mac harness absence, process/launchd/listener observations and updated process inventory. |
| `control-disposition` | Owner disposition, landed implementation and Muster disposition. |
| `change-plan` | Exact jobs, files and app copies to change, deletion diff, before/after plan, routine/webhook disposition and precise rollback. |
| `server-writer-soak` | At least 24 hours of contiguous logged observation intervals with the Mac harness loaded but unused and the server selected as writer. |
| `no-mac-node-soak` | A separate later interval of at least 24 hours with the Mac Node harness absent. |
| `daily-driver` | A separate seven-day native daily-driver observation receipt. |
| `owner-acceptance` | An explicit external owner assertion approving this candidate's Mac-local Node source deletion and seven-day daily-driver acceptance, linked to its original provenance capture. |

Passing command results require the exact named checks exported in `REQUIRED_CHECKS`, exit code zero and a hashed artifact; a free-form success sentence cannot replace them.

The `import` and `rollback` receipts have a producer: `scripts/archive-node-store.mjs` captures the Node store read-only, rehearses its restore and emits both receipts in the shape this bundle validates.   Two of their named checks still need an input the producer cannot make for itself: `parity` needs the importer's parity report, and `restored-health` is a statement about the restored data root rather than about a running harness.   The `replay` receipt has no producer at all, and the `placement` receipt's sixteen recipes are still unrun.

The existing committed `placement-evidence.json` retains all sixteen false assertions; this work does not promote any recipe or live gate to passed.

The collector cannot synthesize owner acceptance through a host reader; it can only package an already captured external acceptance receipt and its original provenance.

## Observation Intervals

The single-writer cutover runbook's Step 4 requires one full day with the Mac writer loaded but unused, health observations with no gap, nonzero inbound traffic, exactly one server run of the shared daily routine and no Mac run.

Its Step 5 then retires the Mac harness; the decommission runbook requires the later `soak-24h-no-node` interval separately.

The seven-day daily-driver sign-off belongs to the owner under the Electron inventory's existing rule.

Each observation receipt records start/end instants and one or more supporting logged coverage segments, which must cover the entire interval in order without gaps or overlaps.

Every segment records its selected execution-writer identity and a separate controller identity/epoch, both bound to the known hosts.

Controller epochs cannot regress across coverage segments or the boundary between the two 24-hour phases; a controller change requires a strictly larger epoch.

Server-writer segments additionally record the loaded-but-unused Mac harness, successful bot/routine/webhook/Zulip/Linear/iOS-push outcomes, nonzero inbound traffic and shared routine counts.

No-Mac-Node segments instead require absent Mac Node and that runbook's functional set, without requiring server-only traffic or suppressing legitimate native Mac routines.

Daily-driver segments separately record signed native use, iOS session, Open on Mac and process-inventory observations; a local-only native Mac controller does not need server traffic or zero Mac routine runs to satisfy daily use.

The checker does not invent a polling cadence; a capture recipe must establish and document the coverage its logs claim.

An elapsed timestamp span alone, an edited JSON file, issue Done, green CI or the earlier loaded-but-unused soak cannot establish the later no-Node soak.

Capture instants must follow their observations, cannot be in the future, and owner acceptance must follow the evidence it accepts.

Machine receipt instants use ISO 8601; human-facing timestamps and the existing placement hand-run display fields retain the owner's America/Chicago 12-hour AM/PM convention without zone labels.

## Prepare A Private Packet

Prepare a request containing candidate identity, mode, hosts, engine inventory, acceptance owner, a hashed relative `state` reference and a `receipts` object.

An empty `receipts` object is the safe starting point and remains blocked; do not fill it using fixture results or assumed owner statements.

Generate a fresh private state file inside a private capture directory using `decommission-gate-state.mjs`; it continues to leave external assertions and Mac harness absence blocking.

`scripts/collect-decommission-evidence.mjs` reads only explicitly named captured files and defaults to a preview with no writes:

```sh
node scripts/collect-decommission-evidence.mjs /private/captures/request.json
```

An explicit output option snapshots the named files into a new private directory and refuses an existing output directory:

```sh
node scripts/collect-decommission-evidence.mjs /private/captures/request.json --out /private/review-packet
```

The collector checks bounds, hashes, identities and recognizable unredacted credentials before packaging; redact captures **before** issuing hashes and receipt references.

Redaction detects known credential shapes and is not a proof that arbitrary input contains no private data; capture recipes must avoid credential/config dumps altogether.

The exported collector accepts injected read-only host readers for future authorized capture adapters; this source supplies no production host adapter and runs no network request, subprocess, daemon, listener, install, launchd action or retirement.

Default collection reports every missing receipt and does not validate or authorize deletion.

## Run The Final CLI

Use exact reviewed candidate values rather than placeholders:

```sh
node scripts/check-decommission-gates.mjs /private/review-packet/state.json \
  --bundle /private/review-packet/bundle.json \
  --source-sha "$CANDIDATE_SOURCE_SHA" \
  --build "$CANDIDATE_BUILD" \
  --artifact-sha256 "$CANDIDATE_ARTIFACT_SHA256"
```

The state and bundle must be in the same private packet, and the bundle must hash the exact state bytes the CLI evaluates.

Missing, malformed, mismatched, unsafe or incomplete evidence refuses the final CLI even when every issue and boolean prerequisite passes.

Exit zero means only that the bound packet and explicit assertions are internally consistent; confirm authentic provenance and the actual owner's authorization independently before the separately authorized live action.

No signed artifact, production receipt, live observation, owner acceptance or decommission action was created by implementing this checker.
