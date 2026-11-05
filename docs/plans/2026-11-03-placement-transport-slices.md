# Placement Transport Slices

Refs BF-2559, BF-2544, BF-2634 and BF-2632.  This splits the remaining placement transport work into pieces different agents can take without writing the same file at once.  The design stays `docs/plans/2026-10-29-native-server-mode.md`;  this document only sequences it against the source as it stands.

It was read from the source on Nov 3, 2026, with #1565 and #1556 read as open pull requests,  and re-read against main on Nov 5, 2026, when T1, T2, T3, T4 and T6a had landed.  Nothing here was run, and "exists" means present in source, not proven working.  All sixteen placement assertions stay false, and no slice may change them.  Every row that moved names the slice that moved it, so a reader knows what a slice left behind and what is still unwired.

## What Exists

| Element | State | Where |
| --- | --- | --- |
| Controller lease book and routes | Exists, controller side only | `server/placement-leases.ts`, mounted in `server/index.ts` |
| Durable controller state | Exists, no production writer | `server/placement-store.ts` is selected only by a UUID marker, and nothing in production writes one |
| Worker authentication | Exists since #1565, answers 503 by design | `server/placement-worker-auth.ts`, `shared/placement-worker-http.mjs` |
| Rollback read-only authority | Exists since #1556 | `server/placement-readonly.ts` |
| Queue and `JobRegistry` registration | Exists since T4 | A job start in a server mode calls `enqueue` on the controller, and a host that does not hold the controller refuses with a reason instead of queueing locally |
| Server placement mode record | Exists since T3 | The server stores the mode beside `jobs.json`, and the registry bridge reads it since T4 |
| Worker client and runtime | Exists since T1, no production caller | `server/placement-worker-client.ts` speaks to the worker routes, and nothing in production constructs it;  Swift only reads identity |
| Worker job discovery and payload delivery | Exists since T2, no production caller | The `assignment` intent hands the worker a job id and a lease, and the `payload` intent delivers the command, checked against the immutable digest |
| Durable report spool | Exists since T1, no production caller | `server/placement-report-spool.ts` is the durable report spool, and no production caller wires it yet |
| Unreachable sweep | Exists, called since T4 | `sweepUnreachable` runs on the controller's heartbeat period, and nothing is requeued |
| Applied-mode acknowledgement | Exists on the server since T3 | `GET /api/placement/mode` returns it, and the Swift client that reads it is T7 |
| Two-process fixtures | Exists since T6a | `server/testing/two-process.ts` starts a controller and a worker pair, `server/testing/fault-proxy.ts` is the fault link and `server/testing/nonce-job.mjs` is the nonce job;  the T6b scenarios are still to come |

## The Wire Mapping

The design says "The worker pulls;  the controller never dials the Mac", so production uses pull.  #1565's worker intents and the lease actions use different words, and this table is the mapping for slices T1 and T2.  The worker's identity always comes from its verified credential, never from a body field.

| Worker intent | Meaning | Controller operation |
| --- | --- | --- |
| `register` | Announce capabilities and a sample | `register` |
| `heartbeat` | Report leases, admission and a sample;  receive the epoch and pending stops | `heartbeat` |
| `assignment` | Ask for work | New selection of the oldest job eligible for this host, then the existing `claim` compare-and-set.  The same issuing lease replays after a restart.  The reply carries the lease and no command |
| `payload` | Fetch the command for a lease this host holds | New read through `server/placement-payloads.ts`, checked against the immutable digest.  It never consumes the claim |
| `report` | Report a terminal result | `report`, idempotent on the job |
| `stop-receipt` | Acknowledge a delivered stop | New, checks the lease and stores nothing.  `report` still settles the lease |

`dispatch` stays out of the worker path and gets no production caller.  The owner routes for `release`, `release-controller` and `takeover` stay owner routes.  Every worker body keeps #1565's strict envelope and adds the controller and epoch fence, and a stale epoch is refused with the current pair.

## Slices

Sizes are rough.  "First" names who must merge first where two slices share a file.

| Slice | Goal | Files | Needs | Proof | Size |
| --- | --- | --- | --- | --- | --- |
| T1 | Worker client and fsynced report spool, behind an injected link | New `server/placement-worker-client.ts`, `server/placement-report-spool.ts` | #1565, this mapping | A dropped acknowledgement then replay settles once, against an in-process lease service | M |
| T2 | Worker routes behind an optional transport argument, plus job selection and payload read.  `server/index.ts` does not pass one, so production keeps answering 503 until T9 | `server/placement-worker-auth.ts`, new `server/placement-worker-routes.ts`, `server/placement-leases.ts` | #1565 | Route tests over a real harness child, and refusals for an owner credential, a wrong host, a stale epoch and a replay | M |
| T3 | Server mode record and the applied acknowledgement | New `server/placement-mode-store.ts`, a route in `server/index.ts` | Shares the lease service's epoch, with no second epoch | Mode and epoch survive restart, and a stale `PUT` is refused | S to M |
| T4 | Registry bridge:  `job_start` becomes `enqueue` in a server mode, and the sweep timer starts | `server/jobs/registry.ts`, new `server/placement-controller-bridge.ts`, `server/index.ts` | T3 | `placement-queue.test.ts` still passes, and `localOnly` behavior is unchanged | L |
| T5 | Worker runtime:  heartbeat, assignment, lease record before spawn, stop, report, restart reconciliation | New `server/placement-worker-runtime.ts`, a hook in `server/jobs/registry.ts` | T1, T2, T4 first | The T6b scenarios | L |
| T6a | Two-process launcher, TCP fault proxy and nonce job | New files under `server/testing/` | Nothing | The proxy's own tests | M |
| T6b | Scenarios:  dropped acknowledgement, disconnect after completion, report replay, controller restart, worker restart, takeover, stale epoch | Tests only | T5, T6a | One nonce file and one spawn in each case, and stale epochs refused | M |
| T7 | Swift acknowledgement client | New `ios/Sources/CompanionCore/PlacementModeClient.swift`, `ServersCoordinator.swift` | T3's route shape | Contract test on shared frames, run on a Mac | S to M |
| T8 | Evidence recipes in `docs/verification/`, with `placement-evidence.json` left false | Docs | T6b | A human asserts later, from real runs | S |
| T9 | Reviewed activation | To be designed | #1556 built and retained first, T6b | Needs an exact packet and the owner's decision | Not sized |

T1, T3, T6a and T7 can run at the same time.  Single writers:  `placement-worker-auth.ts` and `placement-leases.ts` belong to T2, and `jobs/registry.ts` goes to T4 and then T5.  `server/index.ts` merges in the order T3, T4, with small hunks, and T9 is what finally passes the worker transport to it.

## Authority And The Rollback Bridge

Production runs the legacy JSON epoch store today.  After #1556, a UUID marker selects read-only authority and constructs no writer, and the SQLite writer stays reachable only through its module interface for isolated fixtures and later reviewed activation.  So T1 to T6 prove themselves in fixtures with that writer, and no slice wires it into production.  T9 does that, and only after a compatible bridge release is built and retained, as `docs/plans/2026-11-03-placement-rollback-bridge.md` requires.

## Open Questions

The handoff records the owner's choice of the recommended Server First defaults, so these follow the design's recommendations unless the owner says otherwise:  a worker token class for the Mac (question 3, now #1565), a BF issue for the Swift worker when worker mode opens (question 5), and This Mac Only keeps refusing past its running cap (question 8).

Still open:

- **Question 10:**  whether the server's probe fails closed on an unknown reading.  The design proposes it and states no recommendation in the question.  T4 needs an answer.
- **Credential custody:**  who enrolls workers and writes the authorization records.  #1565 reads them and does not issue them.
- **Timing knobs:**  the design names heartbeat and unreachable-window knobs, `server/knob-map.ts` has none, and the unreachable window is a hard-coded default.  T4 or T5 adds the rows.

#1565's new loopback check does not change behavior, because `handleBootRequest` and `handleRequest` already apply the same test on main.

A worker client must not use `fetch`:  it adds a `sec-fetch-mode` header, and the boundary refuses every `sec-*` header.

Not yet determined:  whether `JobRegistry`'s public API is enough for T5, and whether a marker exists on any live data directory.  Nobody should assume an answer to these.
