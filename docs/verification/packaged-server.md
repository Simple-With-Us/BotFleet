# Packaged server smoke test

The packaged server smoke test verifies that the built server starts without access to repository `node_modules`.  This catches bare-import errors that unit tests miss because the repo's node_modules walk up the tree.

## Setup and Purpose

The test copies the built server (`dist-server`) out of the repository into a staging directory with no `node_modules`, then attempts to start it:

```sh
pnpm build:server
node scripts/smoke-packaged-server.mjs
```

This reproduces the exact condition an end user faces when installing the app: the server must resolve all dependencies from bundles or fallback to system node, never from the repo.

## Steps

```sh
# 1. Build the server
pnpm build:server

# 2. Run the smoke test
node scripts/smoke-packaged-server.mjs

# 3. Expected output:
# - "smoke test: server started on port <n>"
# - No MODULE_NOT_FOUND or import resolution errors
# - Clean exit with code 0 after 2-3 seconds
```

## Expected Evidence

A passing run shows:

- **Output:** Exactly one line reporting successful startup: `smoke test: server started on port <PORT>`
- **No errors:** stderr is empty; no unresolved imports logged
- **Clean exit:** The process exits with code 0
- **Port confirmation:** The server bound to a free port and responded to a health check

## History

Version 0.1.24 shipped a server that died on every launch with `ERR_MODULE_NOT_FOUND: Cannot find package 'zod'` because `tsc` leaves bare imports verbatim and the packaged app carries no `node_modules`.  The unit suite ran in the repo (where zod resolves) and passed; only the packaged smoke test would have caught it.

The copy-out-of-repo design is load-bearing: do not simplify it away or re-run the test inside the repository, or the test loses all value.

## Cleanup

The test removes its staging and home directories.  On Windows or Linux, the OS may hold file handles briefly after process exit; retries are built in and failures do not block shipping.  Server logs remain at the printed path.
