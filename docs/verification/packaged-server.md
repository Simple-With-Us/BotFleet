# Packaged server smoke test

The packaged server smoke test verifies that the built server starts without access to repository `node_modules`.  This catches bare-import errors that unit tests miss because the repo's node_modules walk up the tree.

## Setup and Purpose

The test copies the built server (`dist-server`) out of the repository into a staging directory with no `node_modules`, then attempts to start it:

```sh
pnpm build:server
node scripts/smoke-packaged-server.mjs
```

This reproduces the exact condition an end user faces when installing the app: the server must resolve all dependencies from bundles or fallback to system node, never from the repo.

## Runtime modes

The gate runs the server on one of two runtimes, and it always says which one it ran.

A **runtime pass** boots the packaged binary, `Contents/MacOS/BotFleet`, with `ELECTRON_RUN_AS_NODE=1`.  That is the runtime the shipped app uses, so a runtime pass proves the runtime that ships can start the packaged server.

A **bundle check** boots the packaged server tree with the runner's own Node.  It proves the tree is complete and that it starts, and it says nothing about the packaged binary.

`scripts/smoke-runtime-mode.mjs` makes that choice and runs the gate:

```sh
node scripts/smoke-runtime-mode.mjs gate --app release/mac-arm64/BotFleet.app \
  --dist release/mac-arm64/BotFleet.app/Contents/Resources/server
```

The choice is arch-driven.  The packaged binary's architectures, from `lipo -archs`, are compared with the host's.  A runtime pass is taken only when the host can exec the binary.  A cross-arch release entry, an x64 app on an arm64 runner, cannot exec its own binary, so it runs as a bundle check and is labelled as one.

The label is in the output of both the mode script and the smoke script, and in the job's step summary.  Every report names both kinds, so a reader who never saw the workflow file can still tell a runtime pass from a bundle check:

```
smoke mode: bundle (bundle check)
smoke gate kind: bundle check -- this is NOT a runtime pass
smoke reason: the packaged binary is x64 and this host is arm64, so it cannot be exec'd here
```

`OMB_SMOKE_RUNTIME` names the packaged binary for the smoke script directly.  A named runtime that cannot be executed fails the gate.  It never falls back to the runner's Node, because a silent fallback would report a bundle check's result as a runtime pass.

## Steps

```sh
# 1. Build the server
pnpm build:server

# 2. Run the smoke test
node scripts/smoke-packaged-server.mjs

# 3. Expected output:
# - "smoke mode: bundle (bundle check)"
# - "packaged server started with no node_modules in reach (port <n>)"
# - No MODULE_NOT_FOUND or import resolution errors
# - Clean exit with code 0 after 2-3 seconds
```

## Expected Evidence

A passing run shows:

- **Output:** Exactly one line reporting successful startup: `packaged server started with no node_modules in reach (port <PORT>)`
- **No errors:** stderr is empty; no unresolved imports logged
- **Clean exit:** The process exits with code 0
- **Port confirmation:** The server bound to a free port and responded to a health check
- **Named mode:** the run states which runtime it used, a runtime pass or a bundle check

## History

Version 0.1.24 shipped a server that died on every launch with `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'` because `tsc` leaves bare imports verbatim and the packaged app carries no `node_modules`.  The unit suite ran in the repo (where zod resolves) and passed; only the packaged smoke test would have caught it.

The copy-out-of-repo design is load-bearing: do not simplify it away or re-run the test inside the repository, or the test loses all value.

Until BF-1991 the gate always booted the runner's Node, while production ran the packaged Electron binary under `ELECTRON_RUN_AS_NODE=1`.  A build could pass this gate and still die under the runtime it shipped on.  The install-time probe in `scripts/update-botfleet-mac.mjs` already booted the packaged binary; the gate now does too wherever the host can exec it.

## Cleanup

The test removes its staging and home directories.  On Windows or Linux, the OS may hold file handles briefly after process exit; retries are built in and failures do not block shipping.  Server logs remain at the printed path.
