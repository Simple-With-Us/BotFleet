# Node Decommission Source Plan (BF-2515)

Status: source-only plan.  No deletion, bootout, deployment, credential change or live cutover is authorized or performed by this document.

Basis: measured on `origin/main` at `1cceee8b` on Nov 3, 2026 with `git ls-files`.  Every tree count below is against that revision.  The counts were re-verified against `main` at `66e64951c`, which changed only `.github/workflows/` and `scripts/ci-change-scope.node-test.mjs`, so the numbers still hold;  the `ci.yml` line references are against `66e64951c`, where the blobless-checkout merge moved them.  Both were re-verified once more against `main` at `30db2136`, the dependency bump that landed  after this plan was written:  it changed the contents of `package.json` and nothing else, so every  count and every line reference below still holds.  The counts are the same against the committed tree (`git ls-tree -r --name-only HEAD`) that the tree  gate reads, so the plan and the gate judge the same tree.  This plan pairs with BF-2514, which owns the single-writer cutover and the 24-hour no-Node soak.

## What the tree holds today

| Root | Tracked files | Non-test files |
| --- | --- | --- |
| `server/` | 809 | 393 |
| `companion/` | 38 | 18 |
| `shared/` | 104 | 62 |
| `electron/` | 133 | 74 |
| `deploy/` | 18 | 13 |
| `cloudflare/` | 9 | 8 |

`shared/` is flat, with `shared/fixtures/` as its only subdirectory, so there is no Node-only shared subtree to name.  `shared/` is not Node-only either: of its 104 tracked files, `server/` imports 52, `src/` imports 9, `electron/` imports 1 and `scripts/` imports 3, while no Swift file imports it, `cloudflare/` imports none of it, and `companion/` reaches it only from a test.  47 of the 104 are imported by none of the Node roots.

The desktop Node dependency closure lives in the single root `package.json`, with 22 dependencies and 27 devDependencies.  The server-only packages are `@openfeature/server-sdk`, `@sentry/node`, `@sentry/profiling-node`, `clutch`, `ajv`, `ajv-formats`, `typebox` and `yaml`.  The Electron-only ones are `@sentry/electron`, `@trycua/cua-driver`, `electron` and `esbuild`.  `zod` is the only package that also crosses into `cloudflare/`.  Nothing under `native/` or `ios/Sources` imports a dependency.

## The retention floor is wider than one directory

The optional Linux deployment is retained by rule (BF-2544), and keeping only `deploy/linux-server/` does not keep a runnable closure:

- [deploy/linux-server/start.sh](../../deploy/linux-server/start.sh#L95) execs `$code_root/server/index.ts`.
- [deploy/linux-server/botfleet-server.service.in](../../deploy/linux-server/botfleet-server.service.in#L28) runs `@BF_ROOT@/bin/start.sh`, and line 23 sets `OMB_STATIC_DIR=@BF_CODE@/dist`.
- [deploy/linux-server/update.sh](../../deploy/linux-server/update.sh#L58) runs `pnpm install --frozen-lockfile` and line 59 runs `pnpm exec vite build`; [deploy/linux-server/install.sh](../../deploy/linux-server/install.sh#L169) and 170 do the same.
- [vite.config.ts](../../vite.config.ts#L6) and [vite.config.ts](../../vite.config.ts#L7) import `./server/sentry.ts` and `./server/runtime-identity.ts`, so the UI build itself needs `server/`.
- [server/index.ts](../../server/index.ts) imports 26 files from `../shared/`, so `server/` needs `shared/`.

That is the floor, not a deletion target.  [docs/native-rewrite-linux-source-retention.md](../native-rewrite-linux-source-retention.md) records the same boundary, and its citation for the service unit was stale; the same change corrects it.

## The three Done conditions and what answers them today

BF-2515's own Done condition is the first row below, and it carries an owner-qualified exception: the issue asks for no `server/`, `companion/` or desktop `package.json` on main "or only the ruled companion host", so the Phase 5 ruling can leave a slimmed `server/` behind.  These three rows are the conditions BF-2515 owns.  They are NOT the complete deletion gate.  The authoritative gate is [scripts/check-decommission-gates.mjs](../../scripts/check-decommission-gates.mjs), and it requires the `control-disposition` evidence, which is BotFleet Control's post-Node disposition under BF-2583, and the `linux-server-preservation` evidence, which is BF-2544's maintained Linux source, build, update and rollback closure, alongside `placement-evidence`, `replay-parity`, `final-import-parity` and the 24-hour soak that BF-2514 owns.  Nothing in this plan replaces or relaxes any of them, and a green row below is not permission to delete.  The three rows are measured after the deletion, not before it: the tree and the CI job set can only be observed  once the roots are gone, and the reboot question can only be answered after a real reboot.  They are therefore not a precondition of the deletion, and they do not authorise one; the pre-deletion gate in the  Order section does.

| Condition | State | What answers it |
| --- | --- | --- |
| No `server/`, `companion/` or desktop `package.json` on main, or only the ruled companion host | Not met | Nothing asserts absence.  [scripts/audit-node-decommission.mjs](../../scripts/audit-node-decommission.mjs) reports files that no inventory row names, which is coverage rather than a missing tree. |
| CI green with no Node desktop job | Not met | Nothing reads the workflow job set or a CI verdict. |
| No BotFleet `node` process after a reboot | Instrument only | [scripts/check-post-reboot-node.mjs](../../scripts/check-post-reboot-node.mjs) covers processes, launchd and ports with `MAC_LOCAL_ROOTS` of `server`, `companion` and `electron`, and it needs macOS and a real reboot, so it has never run. |

The 24-hour soak is human-only by classification, at [scripts/decommission-gate-state.mjs](../../scripts/decommission-gate-state.mjs#L140), and BF-2514 owns it.

## The three source changes that would make the gate self-proving

Each is source-only, each carries a node test, and each is wired next to the existing gate test.  The three land together in  [#1569](https://github.com/Simple-With-Us/BotFleet/pull/1569).

1. `scripts/check-decommission-tree.mjs` asserts the tracked tree no longer carries the decommissioned roots, and that no desktop `package.json`, `pnpm-lock.yaml` or workspace manifest survives.  It fails closed on an unreadable tree rather than passing.  It reads the committed tree, not the staging index, because the question is what main carries.  It asserts the full removal: if the Phase 5 ruling keeps a slimmed companion host, that ruling is what changes this contract, and the gate would then have to name the host it accepts.
2. `scripts/check-node-ci-jobs.mjs` parses `.github/workflows/*.yml` and fails while any job still references the Node desktop chain (`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm install`, `pnpm package:*`, `vite build`, `electron-builder`, or the `typecheck + test` contexts).  A root `pnpm install` counts, because the root manifest and lockfile hold the whole desktop  dependency closure, so a job that installs it cannot outlive the desktop.  It names the jobs it rejects, so a removal is auditable.
3. `scripts/check-soak-24h.mjs` reads the reboot check's JSON at the start and end of the window together with the absence of the harness service, and proves the window elapsed.

## Order

BF-2515's three conditions are measured after the deletion, not before it, and the deletion is authorised by a different gate.  The order is:

1. Land the three scripts and their tests.
2. Stop the Mac harness, then run BF-2514's cutover and the 24-hour no-Node soak.  That is BF-2514's work, and it  produces the `soak-24h-no-node` evidence the deletion gate asks for.
3. The authoritative pre-deletion gate, [scripts/check-decommission-gates.mjs](../../scripts/check-decommission-gates.mjs),  decides whether the deletion may happen.  It asks for the replacement issues to be Done (BF-2510, BF-2511, BF-2512,  BF-2513, BF-2503, BF-2504 and BF-2514), for the evidence to be asserted (`placement-evidence`, `soak-24h-no-node`,  `replay-parity`, `final-import-parity`, `inventory-clean`, `control-disposition` and `linux-server-preservation`), and for  the Mac no longer running the Node harness.  It also requires the private final evidence bundle, so the issue states and the  evidence booleans alone cannot permit the deletion:

   ```
   node scripts/check-decommission-gates.mjs <state.json> --bundle <bundle.json> \
     --source-sha <exact-source-sha> --build <exact-build> --artifact-sha256 <signed-artifact-sha256>
   ```

   The bundle binds every receipt to one candidate, hashes every artifact it cites,  and carries the owner's explicit acceptance, so a passing run proves the bindings are  consistent rather than that the evidence is true.  The runbook's Step 0 is the canonical command to copy.
4. The owner deletes the retired roots and the desktop manifest.  That step is irreversible, and it is the owner's.
5. Only now are the three conditions above measurable, and that is what the three scripts are for: the tree gate reads the  committed tree, the CI gate names the surviving Node desktop jobs, and the reboot check answers the process question  after a real reboot.

The soak gate holds the 24-hour window on the two ends it observes; BF-2514's continuous observation remains the acceptance  for the window itself.

Steps 2 and 4 are the owner's and BF-2514's.  This plan schedules them and assumes none of them.  A green row in the  table above is not permission to delete: the table is measured after the deletion, and the deletion is authorised by the  gate in step 3.

## Two open questions for the owners

- The required-check list of ruleset `21771270` is not determinable from the tree.  No local ruleset file exists, and only the identifier survives, at [ci.yml](../../.github/workflows/ci.yml#L93) and [ci.yml](../../.github/workflows/ci.yml#L186).  The answer to which job has to go depends on it.
- The `harness` dependency at [package.json](../../package.json#L117) has no import site anywhere in the tree.  Whether it is dead or resolved indirectly needs an owner.
