# Linux Retained Closure Verification

BF-2633 defines exact reviewed source retention for the maintained `main` deployment contract; it does not change the Linux runtime, install a service or establish production preservation.

The reviewed policy is `deploy/linux-server/retained-source.json`, with one exact path, ownership category and reason per row.

Discovery uses immutable Git blobs and esbuild's parser graph for the raw harness, owner gate, Vite configuration, UI, install compiler and named Linux verification entrypoints.

Explicit seeds cover deployment templates/helpers, root package/lock/workspace/patch inputs, runtime proxy declarations, externally loaded extension/manifest assets and every tracked public file that Vite copies into the Linux UI.

The policy retains required Electron library helpers without exempting the Electron application, Mac launcher or updater by directory prefix.

New imports, unknown proxy expressions, missing files, links and ownership drift refuse collection until the policy diff is reviewed.

Graph discovery is conservative and does not prove arbitrary configuration-driven behavior or replace the later clean-export/runtime fixture.

## Immutable Receipts

The collector records source SHA, separately pinned policy source SHA/path/hash, exact file Git blobs/SHA-256/modes, maintained `main` ref, Node/pnpm contract versions, dependency lock/workspace hashes and install-compiler hash.

For ordinary files the content SHA-256 binds the Git blob bytes; an LFS row separately binds the immutable pointer blob, declared object OID/size and materialized content SHA-256.

The collector verifies only already available local LFS objects and returns every missing path/OID/size instead of emitting a successful receipt; it never runs git-lfs, smudges implicitly or fetches an object.

The current source uses its own committed default policy; a prior revision that predates the policy may use an explicitly reviewed `retained-source-<prior-source-sha>.json` from the separately pinned policy commit.

Both policies must exactly match discovery for their own source revision; a historical receipt never pretends that a newly written policy existed in the old commit.

Generate discovery into a new file for review, rather than silently overwriting the existing policy:

```sh
node scripts/collect-linux-retained-source.mjs discover "$SOURCE_SHA" --out /private/review/new-policy.json
```

After committing the reviewed policy, collect an exact current-source receipt inside a private directory:

```sh
node scripts/collect-linux-retained-source.mjs collect "$SOURCE_SHA" --out /private/receipts/current.json
node scripts/collect-linux-retained-source.mjs verify /private/receipts/current.json --source-sha "$SOURCE_SHA"
```

For a known prior revision, supply its reviewed historical policy and the actual commit containing that policy:

```sh
node scripts/collect-linux-retained-source.mjs collect "$PRIOR_SHA" \
  --policy-source-sha "$POLICY_SOURCE_SHA" \
  --policy-path "deploy/linux-server/retained-source-$PRIOR_SHA.json" \
  --out /private/receipts/prior.json
```

Receipt directories must be owned by the executing account with mode `0700`, and receipts must be private regular single-link files, normally mode `0600`.

Reads are bounded and refuse changed files, symlinks, hard links, shared permissions, malformed schemas and mismatched source/policy/toolchain bindings.

The immutable verifier reads Git locally and never fetches a ref, authenticates, installs dependencies or contacts a host.

## Precise Deletion Exceptions

`check-post-reboot-node.mjs --check-git --retained-manifest <private-receipt>` recomputes the exact closure for the actual checkout HEAD and its own current policy.

It additionally checks retained working files against their immutable contents and executable modes; dirty files and untracked source under the audited roots cannot hide behind the manifest.

Only an exact approved path is exempted; naming `server` cannot exempt `server/index.ts` or any future sibling.

The source audit includes `shared` alongside server/companion/Electron roots so retained shared libraries receive explicit ownership too.

Process, launchd and listener checks remain independent; retaining Linux source never authorizes a Mac Node process or weakens the native executable inspection.

## Clean Exports And Safe Fixture Execution

The export command creates a new filtered artifact directory containing only verified immutable source files; it refuses an existing destination and creates no Git clone, service root or credentials:

```sh
node scripts/collect-linux-retained-source.mjs export /private/receipts/current.json \
  --source-sha "$SOURCE_SHA" --out /private/fixture/current-export
```

`deploy/linux-server/retained-fixture.mjs` exports a read-only default plan for distinct candidate and known-prior receipts.

Execution requires an explicit opt-in and every injected install/build/start/health/stop adapter before it creates any files; this source supplies no live host adapters.

The executor itself verifies and exports both sources, checks prior startup, attempts candidate update/health and rehearses prior rollback, joining cleanup before another writer may start.

An uncertain start is treated as active until Stop confirms cleanup; an unconfirmed stop prevents rollback from starting a second writer.

The generated toy-repository tests use real isolated loopback children to prove cleanup and rollback orchestration; their simulated dependency/UI adapters are not actual BotFleet install/build/runtime proof.

The later authorized BotFleet fixture must run the frozen offline install in independent copied dependencies, execute the real Vite build and raw source entry, forbid ancestor source/dependency fallback, and verify static assets, declared proxies and authenticated runtime observations against the export receipt.

Its adapters must use private HOME/data/cache/workdir and free ports, disable container/provider/credential discovery, bound and stop only their own children, and inject all account/mount/service/ref/unit-output actions.

Do not execute `install.sh`, `update.sh` or renderer write CLIs against live roots as a fixture; their existing root/host operations and `/etc` destinations are not made safe by DRY_RUN or PATH stubs alone.

Raw-source runtime identity currently comes from Git; a filtered export without Git must retain its explicit unknown/dirty identity instead of fabricating agreement with the candidate SHA.

An actual fixture must record that limitation or use the independently owned Git checkout below before claiming exact runtime identity; hashing an export does not authorize false Git output.

## Official Filtered Git Checkout Alternative

The generated toy-repository test also verifies official non-cone sparse checkout with an exact selected file set and real immutable HEAD, clean tracked status, and the omitted Mac file marked by Git's own skip-worktree handling.

When `extensions.worktreeConfig` is already enabled, the linked fixture keeps common configuration byte-identical and leaves its sibling checkout unchanged.

When that extension is absent, Git enables it in the common configuration; a fleet fixture must refuse that precondition rather than change sibling/common configuration or manually hide modified files.

`scripts/linux-retained-checkout.mjs` provides an opt-in independently owned alternative: a depth-one exact-commit fetch over `file://` into a new repository, private HOME/configuration, official sparse selection and detached real HEAD.

Its default API call returns a plan; execution verifies clean tracked status, exact selected working files/content, independent Git metadata, no alternates/shared refs/hardlinked objects, and unchanged source common configuration.

Checkout suppresses implicit LFS smudge, denies network transports, and disables Git lazy fetching; Git documents `GIT_NO_LAZY_FETCH` in its [environment variable reference](https://git-scm.com/docs/git).

LFS execution additionally requires the explicit offline materializer: it copies only verified local objects and installs a fixture-local clean filter that emits the original pointer only for the exact declared content hash/size.

The adapter refreshes conversion for those paths using official renormalization and proves the index tree hash remains unchanged; it never invents Git identity or hides changed content with manual index flags.

The generated ordinary/LFS toy fixtures prove this contract, including missing objects, same-size changed content, exact HEAD and clean index; actual BotFleet fixture creation still requires review and separate authorization.

The read-only `--estimate <exact-source-sha>` command reports unique one-commit raw blob bytes, excluding history; compressed transfer/tree overhead and materialized LFS storage are separate costs.

No actual fleet sparse fixture was created by the toy test, and the default executor still creates exports rather than claiming those exports have Git provenance.

All fixture results remain source-test evidence, and the final Linux-preservation assertion stays false until actual candidate/prior build/start/update/rollback acceptance is recorded.

## Linux Retention Receipt

The decommission evidence bundle's `linux-retention` receipt has a producer: `scripts/emit-linux-retention-receipt.mjs` reads an executed fixture result and the two closure receipts that run was made from, and writes `linux-retention.receipt.json` in the shape `scripts/decommission-evidence-bundle.mjs` validates.

The producer runs no fixture, starts no process, contacts no host and neither reads nor edits the gate state; it only converts files that were already captured.

Do not use the fixture's output root as the capture directory: it also holds the `prior/` and `candidate/` checkouts, and the capture directory travels as the evidence packet.  Copy `actual-source-runtime-result.json`, both closure receipts and the provenance record into a separate capture directory owned by the executing account, mode `0700` with `0600` files, then run:

```sh
node scripts/emit-linux-retention-receipt.mjs \
  --capture /private/captures/capture \
  --request /private/captures/request.json \
  --result /private/captures/capture/actual-source-runtime-result.json \
  --candidate-closure /private/captures/capture/current.json \
  --prior-closure /private/captures/capture/prior.json \
  --provenance-record /private/captures/capture/linux-retention-provenance.txt \
  --provenance-source "$PROVENANCE_URL" --provenance-by "$WHO"
```

Every argument is one of those flags, given once and followed by its value; `--provenance-at <iso-8601-instant>` may be added, and without it the receipt is stamped with the time it was emitted.  A flag that has lost its value, a flag given twice and an argument the command does not read are refused, so a mistyped `--provenance-at` is never ignored and never replaced by the current time.

Every cited file is read through the bundle's own reader, so a file the bundle would refuse is refused here first: a symlink, a hard link, a file with group or other access, a path outside the capture directory, a path the bundle's reference format cannot name and a file over the bundle's 1 MiB per-file limit.

A closure receipt may be up to 4 MiB while the bundle reads at most 1 MiB of one file, so an oversized closure receipt is refused with its size instead of producing a receipt the bundle rejects later.

The receipt pins `maintainedSourceSha` to the source the candidate closure receipt names and `rollbackSourceSha` to the source the prior closure receipt names, and its `closureManifest` is the candidate closure receipt bound by hash.

The four exit codes are read out of the result's trace and are never asserted.  The fixture records a step only when its adapter reported success and writes its steps in one fixed order, so each check is read from the position the fixture writes it at:

| Check | Fixture Phases | What The Trace Must Show |
| --- | --- | --- |
| `clean-export-build` | `export-both`, `install-and-build-prior`, `install-and-build-candidate` | `installDependencies` and `buildUi` for the prior and for the candidate. |
| `install-start` | `prior-start-health` | The prior's install and build, then its `start` and `health`, before any candidate step. |
| `update` | `candidate-update-health` | The prior's `stop`, then the candidate's install, build, `start`, `health` and `stop`, one directly after the other, with no `candidate-refused` marker. |
| `rollback` | `prior-rollback-health` | Directly after the candidate's run ended with the candidate stopped, a second prior `start`, `health` and `stop` as the last steps of the run, with no `rollback-refused` marker and an empty `cleanupFailures` list. |

A missing or misplaced step, a refusal marker and a fixture process left behind are honest failures: the check earns exit code 1, the receipt is still written, the command exits 1 and the bundle refuses the failing code.

The command exits 2 and writes nothing when its inputs cannot be read, do not match their contracts or contradict each other, including a plan instead of an executed result, a `candidateHealthy` or `rollbackHealthy` summary that disagrees with the health steps in the trace, a step that ran a source other than the one its slot's closure receipt names, candidate and prior receipts for the same source, a cited file that is the `linux-retention.receipt.json` the command is about to replace, a bundle request that is not a regular file of at most 1 MiB, or a result that claims any preservation status other than the fixture's own `external-runtime-acceptance-still-required`.

The result does not record how the two sources were materialized.  The fixture materializes both before its first step, so a trace that reaches the prior's install had both materialized, but `retained-actual-run.mjs` uses the filtered Git checkout rather than the plain export, and the `clean-export-build` name does not tell the two apart.  Record the materialization in the provenance record.

The producer cannot authenticate the run.  A result written by the toy adapters in the source tests has the same shape as one written by the actual adapters, so the receipt establishes only that the named result is internally consistent, agrees with the named closure receipts and shows what the table above requires.

The receipt never asserts `linux-server-preservation`.  That remains a separate human assertion in the gate state, and it stays false until actual candidate/prior build/start/update/rollback acceptance is recorded.
