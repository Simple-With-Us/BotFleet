# iOS Companion Sync Acceptance Checklist (BF-2652)

Status: checklist plus Slot 1 receipt (`Refs BF-2652`).  Slot 1 is verified offline at the exact revision below.  Slots 2 and 3 are **not verified**, and nothing in this document deploys, enables, grants, or schedules them.

## The Three Evidence Slots

BF-2652 closes only when three different kinds of evidence exist, and none of them substitutes for another:

| Slot | What it proves | State today |
| --- | --- | --- |
| 1. Packaged source | The bridge source on `main` passes its offline contract tests at an exact revision | **Verified** — see the receipt below |
| 2. Authorized running server | An owner-authorized server actually runs that revision and serves the bridge route | **Not verified** — no deploy or enable was done |
| 3. iPhone build + physical device | A named TestFlight build on a named physical device completes pairing, stream, and push checks | **Not verified** — no device run was scheduled |

A green Slot 1 says nothing about Slot 2, and a foreground receipt in Slot 3 does not prove a background wake.  Each slot is filed under its own evidence and never borrowed from another.

## Topology (Owner Direction, Nov 25)

Linux/Hetzner is the primary BotFleet server.  Both the Mac app and the iPhone connect to it.  The Mac's secondary server runs only work that requires the Mac; it is not a peer primary and it is not the iPhone's dependency.  Standalone Mac operation, if supported separately, stays distinct from fleet operation.  No automatic promotion or failover is assumed, and no source merge counts as installed proof.

## Slot 1 Receipt: Packaged Source At An Exact Revision

- **Exact tested revision:** `c202b4d67060dec62d486c97fbf47be6022668c8` (`origin/main`, the BF-2694 iOS slice, PR #2195).  This revision contains the merged bridge core (#2171, #2177), the Phone tab (#2170), and the default-off Linux bridge listener, unit, and policy from BF-2691 (#2190, `37969f8b7`).
- **Lane:** `muse-code/bf2652-checklist-receipt`, cut from `origin/main` at that revision.  Dependencies installed with `pnpm install --frozen-lockfile`.
- **Host limit, recorded plainly:** this host runs Node `v22.22.1` while the package requires Node `>=24`, so TypeScript type-stripping is unavailable here. The bridge server tests were run with `node --experimental-strip-types`, which this Node build accepts for the bridge's own modules. The two retained-source tests in the wider suite fail here with `ERR_NO_TYPESCRIPT` for the same host reason; they are not bridge failures and are not claimed as verified on this host. Hosted CI on Node 24 remains the oracle for those two files.

| Command (in the lane, at the revision above) | Result |
| --- | --- |
| `node --test deploy/linux-server/companion-bridge.node-test.mjs` | 46/46 pass |
| `node --experimental-strip-types --test deploy/linux-server/companion-bridge-server.node-test.mjs` | 35/35 pass |
| Both bridge files together | 81/81 pass |
| `pnpm test:linux-server-install` | 103/105 pass; the 2 failures are the host Node limit above (`retained-source`, `emit-linux-retention-receipt`), unrelated to the bridge |

The earlier 46/46 core result at `a024b67f` is superseded by this receipt: that revision predates the landed #2190 packaging, so only the counts at `c202b4d6` count for BF-2652.

## Slot 2: Authorized Running Server (Not Verified)

What would prove it, none of which was done here:

- The serving host reports its exact revision (`git -C <serving checkout> rev-parse HEAD`) and it matches a revision whose Slot 1 receipt exists.
- `botfleet-companion-bridge.service` is enabled only under the owner's `BF_COMPANION_BRIDGE=1` decision, listens on loopback, and is published through the owner's `tailscale serve` step.
- The bridge answers its local routes (`/api/companion/endpoints`, pairing, devices) and proxies the fleet, thread, and `/api/events` routes without rewriting cursor parameters.

Until an owner authorizes that deploy, the bridge is packaged source only: the unit is written, default-off, and answers nothing live.

## Slot 3: iPhone Build And Physical Device (Not Verified)

Prerequisites, all owner-side:

- A named TestFlight build of the iOS companion (bundle `app.botfleet.ios`).  The latest BotFleet planner failed before upload, so no current build is claimed here; the exact build number is recorded at run time, never assumed.
- A physical iPhone paired with the **server** bridge (not the Mac), with the Mac asleep for the server-first rows.
- The scoped APNs grant for the Linux sender, by name only: `APNS_KEY_P8`, `APNS_KEY_ID`, and `APNS_TEAM_ID` (or a per-key `AUTHKEY_<key id>`).  Values are never written in this checklist, in Linear, or in chat.

| # | Observe | Expected | Proves |
| --- | --- | --- | --- |
| P1 | Pair with QR, then revoke and pair with the 6-digit code | Both succeed; the revoked credential stops working | Pairing and revocation against the running bridge |
| P2 | Open the roster and a thread | Server-owned state hydrates on the phone | Slot 2 serves real data, not fixtures |
| P3 | Foreground stream drops and resumes | `hello` cursor plus `?since=` / `Last-Event-ID` replay, no duplicates | Foreground SSE only — this row proves nothing about background push |
| P4 | Revoke the device mid-socket | The stream terminates at once and re-pairing is required (`401` until then) | Revocation is live, not just stored |
| P5 | Background the app, then trigger a server-owned event | An APNs alert arrives from the Linux sender | Background wake — the row P3 cannot close |
| P6 | Trigger an approval with the app terminated | The alert and Live Activity arrive; one device, one sender | The one-sender rule across the Mac-asleep seam |
| P7 | Queue a Mac-only job while the Mac is asleep, then wake the Mac | The job visibly waits for the Mac secondary, then resumes exactly once, with no duplicate execution and no second authoritative writer | Primary and secondary stay in their lanes |

## Non-Authorizations

This document authorizes nothing.  It does not authorize a deploy, a service enable, a `tailscale serve` change, an Infisical grant, a key mint, a TestFlight upload, or a physical-device run.  It records what is verified, what is not, and what an owner-authorized run would have to observe to close each row.
