# Node Decommission Source Plan (BF-2515)

Status: source-only plan.  No deletion, bootout, deployment, credential change or live cutover is authorized or performed by this document.

Basis: measured on `origin/main` at `1cceee8b` on Nov 3, 2026 with `git ls-files`.  Every tree count below is against that revision.  The counts were re-verified against `main` at `66e64951c`, which changed only `.github/workflows/` and `scripts/ci-change-scope.node-test.mjs`, so the numbers still hold;  the `ci.yml` line references are against `66e64951c`, where the blobless-checkout merge moved them.  This plan pairs with BF-2514, which owns the single-writer cutover and the 24-hour no-Node soak.

## What the tree holds today

| Root | Tracked files | Non-test files |
| --- | --- | --- |
| `server/` | 809 | 393 |
| `companion/` | 38 | 18 |
| `shared/` | 104 | 62 |
| `electron/` | 133 | 74 |
| `deploy/` | 18 | 13 |
| `cloudflare/` | 9 | 8 |

`shared/` is flat, with `shared/fixtures/` as its only subdirectory, so there is no Node-only shared subtree to name.  `shared/` is not Node-only either: of its 104 tracked files, `server/` imports 52, `src/` imports 9, `electron/` imports 1 and `scripts/` imports 3, while no Swift file imports it, `cloudflare/` imports none of it, and `companion/` reaches it only from a test.  47 of the 104 are imported by none of the Node roots.

The desktop Node dependency closure lives in the single root `package.json`, with 22 dependencies and 27 devDependencies.  The server-only packages are `@openfeature/server-sdk`, `@sentry/node`, `@sentry/profiling-node`, `clutch`, `ajv`, `ajv-formats`, `typebox` and `yaml`.  The Electron-only ones are `@sentry/electron`, `@trycua/cua-driver`, `electron` and `esbuild`.  `zod` is the only package that also crosses into `cloudflare/`.  Nothing under `native/` or `ios/Sources` imports a dependency.

## The retention floor is wider than one directory

The optional Linux deployment is retained by rule (BF-2544), and keeping only `deploy/linux-server/` does not keep a runnable closure:

- `deploy/linux-server/start.sh:95` execs `$code_root/server/index.ts`.
- `deploy/linux-server/botfleet-server.service.in:28` runs `@BF_ROOT@/bin/start.sh`, and line 23 sets `OMB_STATIC_DIR=@BF_CODE@/dist`.
- `deploy/linux-server/update.sh:58` runs `pnpm install --frozen-lockfile` and line 59 runs `pnpm exec vite build`; `deploy/linux-server/install.sh:169` and 170 do the same.
- `vite.config.ts:6` and `vite.config.ts:7` import `./server/sentry.ts` and `./server/runtime-identity.ts`, so the UI build itself needs `server/`.
- `server/index.ts` imports 26 files from `../shared/`, so `server/` needs `shared/`.

That is the floor, not a deletion target.  `docs/native-rewrite-linux-source-retention.md` records the same boundary, and its citation for the service unit was stale; the same change corrects it.

## The three Done conditions and what answers them today

BF-2515's own Done condition is the first row below, and it carries an owner-qualified exception: the issue asks for no `server/`, `companion/` or desktop `package.json` on main "or only the ruled companion host", so the Phase 5 ruling can leave a slimmed `server/` behind.  These three rows are the conditions BF-2515 owns.  They are NOT the complete deletion gate.  The authoritative gate is `scripts/check-decommission-gates.mjs`, and it requires the `control-disposition` evidence, which is BotFleet Control's post-Node disposition under BF-2583, and the `linux-server-preservation` evidence, which is BF-2544's maintained Linux source, build, update and rollback closure, alongside `placement-evidence`, `replay-parity`, `final-import-parity` and the 24-hour soak that BF-2514 owns.  Nothing in this plan replaces or relaxes any of them, and a green row below is not permission to delete.

| Condition | State | What answers it |
| --- | --- | --- |
| No `server/`, `companion/` or desktop `package.json` on main, or only the ruled companion host | Not met | Nothing asserts absence.  `scripts/audit-node-decommission.mjs` reports files that no inventory row names, which is coverage rather than a missing tree. |
| CI green with no Node desktop job | Not met | Nothing reads the workflow job set or a CI verdict. |
| No BotFleet `node` process after a reboot | Instrument only | `scripts/check-post-reboot-node.mjs` covers processes, launchd and ports with `MAC_LOCAL_ROOTS` of `server`, `companion` and `electron`, and it needs macOS and a real reboot, so it has never run. |

The 24-hour soak is human-only by classification, at `scripts/decommission-gate-state.mjs:140`, and BF-2514 owns it.

## The three source changes that would make the gate self-proving

Each is source-only, each carries a node test, and each is wired next to the existing gate test.

1. `scripts/check-decommission-tree.mjs` asserts the tracked tree no longer carries the decommissioned roots, and that no desktop `package.json`, `pnpm-lock.yaml` or workspace manifest survives.  It fails closed on an unreadable index rather than passing.  It reads the committed tree, not the staging index, because the question is what main carries.  It asserts the full removal: if the Phase 5 ruling keeps a slimmed companion host, that ruling is what changes this contract, and the gate would then have to name the host it accepts.
2. `scripts/check-node-ci-jobs.mjs` parses `.github/workflows/*.yml` and fails while any job still references the Node desktop chain (`pnpm test`, `pnpm package:*`, `vite build`, `electron-builder`, or the `typecheck + test` contexts).  It names the jobs it rejects, so a removal is auditable.
3. `scripts/check-soak-24h.mjs` reads the reboot check's JSON at the start and end of the window together with the absence of the harness service, and proves the window elapsed.

## Order

1. Land the three scripts and their tests.
2. Let the gate answer the three conditions honestly while the runtime is still present.
3. Only then propose the owner-gated steps: boot out the Mac harness, delete the retired roots, run the reboot check, then the soak.

Step 3 is the owner's.  This plan schedules it and assumes none of it.  It is also not the whole gate: `scripts/check-decommission-gates.mjs` decides whether the deletion may happen at all, and it needs the Control disposition and the Linux preservation evidence asserted as well as BF-2515's three conditions.  A green row in the table above is not permission to delete.

## Two open questions for the owners

- The required-check list of ruleset `21771270` is not determinable from the tree.  No local ruleset file exists, and only the identifier survives, at `ci.yml:93` and `ci.yml:186`.  The answer to which job has to go depends on it.
- The `harness` dependency at `package.json:117` has no import site anywhere in the tree.  Whether it is dead or resolved indirectly needs an owner.
