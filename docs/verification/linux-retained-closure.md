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
