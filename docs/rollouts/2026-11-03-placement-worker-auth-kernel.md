# Scoped Worker Authentication Kernel

Refs BF-2634, BF-2625 and BF-2544.  This source unit separates an execution worker from the owner before the owner gateway or loopback harness can grant authority.  It creates no credential, enrollment, Infisical grant, activation switch or executable transport.  All sixteen acceptance flags remain false.

## Request Boundary

The reserved authorization scheme is `BotFleet-Worker`, followed by an opaque `bfw1` credential containing a UUID identifier and random secret.  The gateway preserves that authorization unchanged to the harness rather than converting it to owner authority.  The harness independently authenticates it before boot diagnostics, ordinary routes or loopback-owner fallback.  A reserved scheme, credential prefix, worker header or worker namespace always selects this class, including malformed, unknown and revoked credentials; it cannot fall through to an owner login, owner token or uncredentialed loopback owner.

Only exact POST paths under `/api/placement/worker/` are reserved: `register`, `heartbeat`, `assignment`, `payload`, `report` and `stop-receipt`.  Queries, aliases, encoded paths, trailing slashes, browser headers, cookies, forwarded identity, claimed host headers, mixed credentials, duplicate headers and upgrades refuse.  The gateway and harness share the same dependency-free raw-header classifier, so Node's collapsed authorization header cannot hide a duplicate credential.  Worker redirects are replaced with a refusal before Location or cookies reach the client; ordinary owner HTTP, streaming and gateway WebSocket behavior keeps its existing policy.

The strict authentication-only envelope binds `authVersion`, host ID, audience and `execution-worker` role.  A higher version, controller role, extra capability or claimed execution receipt version refuses.  After successful verification the harness returns 503, `Worker transport is not active`, without accessing placement jobs, payloads or owner diagnostics.  These reservations do not advertise an execution-receipt protocol or accept a command; the later transport unit must supply reviewed operation-specific schemas and receipts.  Existing controller enqueue remains local owner/turn bound.

## Verifier State And Custody

The verifier reads one exact credential record from `DATA_DIR/placement-worker-authorizations/<UUID>.json` on each authentication, with no timed cache or credential scan.  The directory must be owned and mode 0700; each metadata file must be owned, regular, single-link and mode 0600.  Reads are bounded to 16 KiB and validate the listed inode, permissions and unchanged file around a no-follow handle.  Missing, malformed, public, linked, oversized or replaced state refuses without creating or repairing anything.

Strict version-one metadata contains only format/version, identifier, revision, bound host, receiving-controller audience, fixed execution role, SHA-256 digest, revocation and optional expiry represented by a required nullable field.  Secret comparison uses equal-length constant-time digest comparison.  The audience is the stable receiving harness host ID; a controller handoff cannot redirect a credential to another host or silently forward it there.  A future handoff needs explicit new audience enrollment and a valid placement fence.

The record is dynamic authorization state, not a tunable setting or raw credential store.  Opening the source performs no enrollment and absent metadata disables worker authentication.  No environment fallback, configuration field or metadata writer/API exists in this unit.  Future enrollment must first establish raw-secret custody in canonical Infisical/native Keychain, then durably publish only its verified digest and bindings; it must preserve revoked IDs rather than reuse them.  The worker principal cannot edit this state.

The verifier re-reads authorization after a request body wait, immediately before the reserved response.  Within a process, observed revisions cannot regress, identifier bindings cannot change and an observed revocation stays refused.  Local files alone cannot prove freshness after a coordinated historical rollback and process restart; this unit does not claim an external monotonic revocation witness or protection from an administrator rewriting authoritative history.  Future transport mutations must retain a fresh authorization check at their actual commit boundary.

Validated, correctly addressed metadata is observed before comparing the presented secret.  Revocation permanently refuses that credential ID within the process; a previously observed ID also remains refused after binding drift, revision rollback or a conflicting same-revision record, even if older or apparently repaired metadata returns.  A wrong secret alone does not poison an ID, and malformed or foreign first records establish no observation.  Other credential IDs remain independent.

## Isolated Verification

The fixtures use fresh random test credentials, private temporary metadata and free loopback ports.  Only digests enter fixture metadata; no credential is printed, provisioned, sent to a provider or persisted in ordinary configuration.  An actual harness and owner gateway exercise every reserved intent, owner-only routes, forged host/audience/role, unsupported envelopes, unknown/revoked credentials, mixed/duplicate headers, browser/forwarding tricks and WebSocket refusal.  Source-only HTTP fixtures also prove malformed/owner-route claims cause no metadata read, revocation during body parsing is rechecked, redirects cannot escape the worker namespace and ordinary owner proxy behavior remains intact.

The original owner-gate negative fixture could accidentally reuse its valid random token when replacing the last character with `0`.  Its fixture now always changes that character; no owner authentication behavior changed.  The coordinating session owns independent invariant review, full-gate delivery and publication.  Actual credential enrollment, retained rollback artifact/runtime proof, worker execution receipts and mode activation remain separate gates.

The composed focused run passed 99 cases across seven worker-auth, placement and stop-policy suites.  After retaining the standing loopback Host check ahead of worker handling and making metadata opens nonblocking, all 34 affected HTTP/auth/identity cases passed again.  Both direct TypeScript stages, the unchanged 4,867-warning lint baseline and all 67 owner-gate/decommission checks passed on the final source.  The earlier syntax-helper, browser-like fixture-client and random-token negative failures remain preserved receipts; the worker client fixtures now use actual native HTTP requests rather than a browser-like fetch implementation.

Independent review reproduced three metadata-observation failures before the correction: revocation seen with a wrong secret, binding drift followed by restoration, and a higher revision seen with a wrong secret followed by rollback.  The negative control for wrong secrets and invalid first records passed.  The correction passes all 38 affected auth/HTTP/identity cases, both direct TypeScript stages, the unchanged 4,867-warning lint baseline and all 67 owner-gate/decommission checks.  These focused receipts do not replace the coordinating session's full gate or authorize enrollment or activation.

```sh
VITEST=true node node_modules/vitest/vitest.mjs run server/placement-worker-auth.test.ts server/placement-identity.test.ts server/placement-controller-epochs.test.ts server/placement-leases.test.ts server/placement-store.test.ts server/bot-stop-wiring.test.ts server/bot-stop-policy.test.ts --maxWorkers=1
node node_modules/typescript/lib/tsc.js -b --pretty false
node node_modules/typescript/lib/tsc.js -p tsconfig.server.json --pretty false
node scripts/check-lint-baseline.mjs
node --test deploy/linux-server/owner-gate.node-test.mjs scripts/decommission-gates.node-test.mjs
git diff --check
```
