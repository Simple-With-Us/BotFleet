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

The `import` and `rollback` receipts have a producer: `scripts/archive-node-store.mjs` captures the Node store read-only, rehearses its restore and emits both receipts in the shape this bundle validates.  Each exit code in those receipts is read out of the report it names, so a failed rehearsal earns a failing code and this bundle refuses it.  Two of their named checks still need an input the producer cannot make for itself: `parity` needs the importer's parity report, and `restored-health` is a statement about the restore rather than about the store or about a running harness.  The `parity` check's verdict is computed out of that report's own details, the way `StoreImportParityReport` computes it on the Swift side, and the report's own flags have to agree with what the producer recomputed.  A report that says it was verified while a surface disagrees, a report missing any of the fields the verdict is computed from, and a report whose flags contradict each other all fail closed, so the check earns a failing code and this bundle refuses the packet.  The `replay` receipt has a producer as well: `ios/Scripts/EngineReplayParityProbe` replays each inventoried engine's recorded turns through the native driver and writes a per-engine report, and `scripts/emit-replay-receipt.mjs` reads that report and emits the receipt this bundle validates.  A replay report whose summary disagrees with its own per-engine verdicts is refused rather than read, so a report that did not come from the probe cannot certify a replay.  The `placement` receipt's sixteen recipes are still unrun.

The existing committed `placement-evidence.json` retains all sixteen false assertions; this work does not promote any recipe or live gate to passed.

The collector cannot synthesize owner acceptance through a host reader; it can only package an already captured external acceptance receipt and its original provenance.

The `linux-retention` receipt has a producer too: `scripts/emit-linux-retention-receipt.mjs` reads an executed result of the retained Linux fixture and the candidate and prior closure receipts that run was made from, and emits the receipt this bundle validates.  Its four exit codes are read out of the ordered steps in the result's trace, so a missing step, a refused phase or a fixture process left behind earns a failing code and this bundle refuses it.  A plan, a result whose summary disagrees with its own trace, and a result whose steps ran a source other than the one its closure receipt names are refused with nothing written.  The producer cannot authenticate the run, because a result from the source tests' toy adapters has the same shape as an actual one, and the receipt never asserts `linux-server-preservation`, which stays a separate human assertion.  The command, the phase-to-check mapping and the capture-directory rules are in [Linux Retained Closure Verification](linux-retained-closure.md#linux-retention-receipt).

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

## The Process Inventory Receipt Producer

The `process-inventory` receipt has a producer.  `scripts/check-post-reboot-node.mjs --json` is the measurement: it inspects the Mac's processes, launchd jobs and listeners and prints a verdict.  `scripts/emit-process-inventory-receipt.mjs` is the receipt: it reads a saved verdict and the rows captured out of the Mac's process inventory, and emits `process-inventory.receipt.json` in the shape this bundle validates.

```sh
node scripts/emit-process-inventory-receipt.mjs --capture /private/captures/capture \
  --request /private/captures/capture/request.json \
  --verdict /private/captures/capture/post-reboot-verdict.json \
  --inventory-rows /private/captures/capture/inventory-rows.md \
  --provenance-record /private/captures/capture/provenance.txt \
  --provenance-source "$PROVENANCE_HTTPS_URL" --provenance-by "$RUNNER" \
  --provenance-at "$CAPTURED_AT"
```

`--provenance-at` is the instant the verdict and the rows were captured, as an ISO 8601 instant with an offset, and it has no default.  The producer judges the rows' retirement dates against it and records it as the receipt's instant, so it is the capture's and not the moment the producer happens to run.  Taking it right after the capture, `CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"`, is how the runbook does it.

The producer's output carries a `receipts` object, `{"process-inventory": {"path": ..., "sha256": ...}}`, which is empty when no receipt was written.  Merge it into the `receipts` object of the bundle request.  The collector reads only a receipt the request names by path and hash, so a packet whose request does not name this one is blocked with `process-inventory: missing-receipt`.

Each exit code is read out of the file its check cites, and each check cites that file by hash.

| Check | Read From | Earns A Passing Code When |
| --- | --- | --- |
| `processes` | The verdict's `details.processes`. | The list is empty. |
| `launchd` | The verdict's `details.launchAgents`, `launchProbes` and `launchDomain`. | No agent is loaded, every agent label was probed on macOS without a skip, and the launchd domain those probes asked was found and is the owner's own, not root's. |
| `listeners` | The verdict's `details.portListeners`. | No listener's command reads as Node, Electron or BotFleet; the flag is recomputed from the command, and the stored flag is not trusted. |
| `inventory-updated` | The captured inventory rows. | Every captured row whose first cell names the harness is retired in the wording the single-writer cutover runbook's Step 5 sets out, and both names have a row. |

A captured row that mentions the harness only in a later cell is another job's row, or the harness filed under a port or an older label, and the producer cannot tell which.  It does not judge such a row and does not pass over it in silence: the output's `notices` list each one by line number, without the row's text, and they fail nothing.  Those rows are read by a person.

A probe error in the verdict fails all three harness checks, because a probe that failed observed nothing.  `details.gitFiles` is not read: it belongs to the tree check, and before the Phase 6 deletion a `--check-git` verdict always lists files, so the capture runs without `--check-git`.

The producer refuses, with exit code 2 and nothing written, a verdict it cannot judge: one that is missing or malformed, one whose `ok` or `failures` are not what its own details recompute to, one whose listener flags or loaded agents contradict its own commands or probes, and one that is not an observation of a Mac.  The last case is why the verdict carries `platform` and `launchProbes`.  Off macOS the reboot check skips every launchd probe and reports no loaded agent, which reads exactly like a retired harness, so a verdict that is not from `darwin`, that skipped a probe, or that was saved before those fields existed is refused.  On macOS the same thing happens one level up, which is why the verdict also carries `launchDomain`.  The probes ask the GUI domain of the user who ran the check, and launchd answers "not found" for every label when that domain does not exist, as it does for root and for an SSH session with nobody logged in at the console.  A verdict taken as root, or one whose domain was not found, is refused with the same exit code.

The producer reads the three files it cites, the verdict, the rows and the provenance record, through this bundle's own reader.  It refuses, again with exit code 2, a cited file that is a symbolic link, that has a second name, that anyone but the owner can read, that is over the file limit, or that sits outside the capture directory.  So it never earns an exit code from a file this bundle would refuse, and the bytes it hashes are the bytes it judged.

`macHarness: "absent"` is the only value this bundle accepts, and the producer writes it only when all three harness checks are clean.  When one is not, no honest receipt exists: the producer writes nothing, removes the receipt an earlier run left in the capture directory, and exits 1.  The inventory check is separate, because the harness can be gone while the inventory still describes it: that receipt is written with a failing `inventory-updated` code, the producer exits 1, and this bundle refuses the packet.

The `listeners` check inherits the reboot check's rule as it stands.  That rule flags any listener on ports 8799, 8800, 8810 and 8811 whose command reads as Node, Electron or BotFleet, so the native app listening on one of those ports fails the check.  The producer does not loosen it.

The producer cannot establish that the verdict was taken on the Mac the packet names, that it was taken after the retirement, or that the captured rows are every row the inventory holds.  A verdict a person typed has the same shape as one the check printed, and the inventory lives outside this repository, so the producer judges the rows it is given and nothing else.  Like the rest of this bundle, it checks consistency and does not authenticate.

Its fixtures are synthetic and temporary, and they inject launchd's answers: the launchd domain probe has not been run on a Mac.  No production receipt was created by implementing it.

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
