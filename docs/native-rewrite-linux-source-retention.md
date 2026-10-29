# Linux Server Source Retention Contract

Source audit: `main` at `3f1f2ca25d07bbe6f02a7f1f600cb094123f7f1d`.  This records the source contract required by BF-2585, BF-2515 and BF-2544.  It does not establish live deployment or native parity.

## Scope

BF-2515 removes the Mac-local Node harness and its Mac launch path after its gates pass.  BF-2544's optional Linux service is a separate deployment contract: its current service still executes `server/index.ts`.  Removing the Mac runtime does not by itself require deleting source Linux still needs; deleting shared server source would break Linux too unless BF-2544 first lands another supported source/ref.

This note records the source files and build inputs visibly required by today's Linux install/update/service path.  It is not an exhaustive static import closure and does not claim these are the only transitive runtime dependencies.

## Current Linux Contract

- [deploy/linux-server/common.sh](../deploy/linux-server/common.sh#L15) defaults `BF_ROOT` to `/mnt/fleet-extra/apps/botfleet-server`, `BF_CODE` to `/mnt/fleet-extra/Code/BotFleet-server`, `BF_REPO` to the BotFleet repository, and `BF_REF` to `main` (lines 15–21).  The data/runtime root and source checkout are separate.
- [deploy/linux-server/install.sh](../deploy/linux-server/install.sh#L138) fetches or clones `BF_CODE`, refuses a dirty checkout, and checks out `origin/$BF_REF` detached (lines 142–160).  It runs frozen `pnpm install` and `pnpm exec vite build` from that checkout (lines 162–169).
- [deploy/linux-server/update.sh](../deploy/linux-server/update.sh#L45) repeats the clean-checkout check, fetches `origin`, checks out detached `origin/$BF_REF`, installs dependencies, runs Vite, and restarts both units (lines 45–61).  Updates and rollbacks therefore need the configured source repository and deployable refs to remain fetchable.
- [deploy/linux-server/botfleet-server.service.in](../deploy/linux-server/botfleet-server.service.in#L21) sets `OMB_STATIC_DIR` to `@BF_CODE@/dist` and starts `@BF_CODE@/server/index.ts` with the private Node runtime (lines 21–25).  The generated UI's static directory is inside the source checkout; it is not a separate retained artifact today.
- [deploy/linux-server/README.md](../deploy/linux-server/README.md#L7) describes the harness and owner-gate services; the owner gate is separately launched from `deploy/linux-server/owner-gate.mjs` by its own service template.

## Minimum Visible Retention Boundary

Until BF-2544 changes this deployment contract, BF-2515 must preserve at least:

- `deploy/linux-server/` install, update, uninstall, shared shell helpers, service templates, owner-gate implementation, and operator documentation.
- `server/` source used by the Linux harness, including `server/index.ts` and its runtime imports.
- `shared/` source imported by server modules.  For example, `server/index.ts` imports `../shared/*.ts`; the port inventory should assign retained Linux ownership instead of treating every shared file as Mac-only.
- The source needed to rebuild the deployed static UI, including [index.html](../index.html)'s `src/main.tsx` entry, `src/`, `public/`, [vite.config.ts](../vite.config.ts), the package manifest, lockfile and workspace/build inputs used by `pnpm install` and `vite build`.  The Vite configuration also imports `server/sentry.ts` and `server/runtime-identity.ts`, so retaining only UI source would not preserve this build either.
- The private Node runtime under `BF_ROOT/node` remains a Linux deployment prerequisite while the systemd unit executes TypeScript source with Node.

This is a floor from the install/service commands, not a complete dependency manifest.  Resolve the exact retained tree and CI/build inputs in BF-2544 before treating the inventory as exhaustive.

## Preservation And Rollback Preconditions

Before deleting or relocating shared source, BF-2544 must identify a maintained repository/ref and build path that preserve Linux harness startup, UI assets at the configured static path, updates, and rollback to a known prior deployable revision.  The present updater's detached `origin/$BF_REF` flow means a ref name alone is insufficient if its required source/build inputs disappear from that ref.

BF-2515 may retire Mac-only launch, updater/supervisor and runtime packaging paths once its gates pass and retained consumers are accounted for.  A Mac-only soak does not prove the Linux source, UI build, systemd runtime, or rollback path is preserved.

## Gate Boundary

`scripts/check-decommission-gates.mjs` treats `server`, `companion`, `shared`, and `electron` as Mac-local roots, while `deploy/linux-server/` remains an allowlisted retained path.  It also reports the Linux deployment as a dependent surface and requires `linux-server-preservation` before the decommission can pass.  The evidence contract is that BF-2544 has a maintained source/build/update/rollback closure, or a verified replacement preserving Linux harness startup, UI assets, runtime, updates and rollback.

This is a required evidence assertion, not automatic live proof.  The gate and state generator do not inspect a Linux host, fetch deployment refs, build or check artifacts, or exercise rollback.  Do not infer the assertion from the retained directory, `inventory-clean`, a Mac soak, or Linear issue states.  The evidence owner must verify and record the contract before BF-2515 deletes any source used by Linux.

BF-2510's companion endpoint decision and the Control-disposition gate are separate preservation questions.  This contract does not replace or fold either gate into BF-2544.
