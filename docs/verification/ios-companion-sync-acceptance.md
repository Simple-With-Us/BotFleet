# iOS Companion Sync Acceptance Checklist (BF-2652)

Status: checklist plus the Slot 1 and Slot 2 receipts (`Refs BF-2652`).  Slot 1 is verified offline at the exact revision the server serves, and Slot 2 is verified on that server.  Slot 3 is **not verified**, and nothing in this document deploys, enables, grants, or schedules it.

## The Three Evidence Slots

BF-2652 closes only when three different kinds of evidence exist, and none of them substitutes for another:

| Slot | What it proves | State today |
| --- | --- | --- |
| 1. Packaged source | The bridge source on `main` passes its offline contract tests at an exact revision | **Verified** at `c202b4d6` and at `53bb9e15`, the revision the server serves: see the two receipts below |
| 2. Authorized running server | An owner-authorized server actually runs that revision and serves the bridge route | **Verified** on 2026-11-27: see the receipt below |
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


## Slot 1 Receipt: The Revision The Server Serves

- **Exact tested revision:** `53bb9e15c84bc389a6cfd83d876a1ce8b1a16c51` (`origin/main`, after PR #2245, which makes the bridge speak the shipped app's contract, and PR #2248, which answers `401` to a device credential it does not know).  This is the revision the serving host reports in the Slot 2 receipt.
- **Lane:** `zc/bf-2652-slot-2-receipt`, cut from `origin/main` at that revision, working tree clean, Node `v24.16.0`, dependencies installed with `pnpm install --frozen-lockfile`.

| Command (in the lane, at the revision above) | Result |
| --- | --- |
| `node --test deploy/linux-server/companion-bridge.node-test.mjs` | 82/82 pass |
| `node --test deploy/linux-server/companion-bridge-server.node-test.mjs` | 61/61 pass |
| Both bridge files together | 143/143 pass |
| `pnpm test:linux-server-install` | 247/247 pass |

The hosted runs on both pull requests' heads passed the whole gate on both systems before each merge: typecheck and test, lint, gitleaks, and the Swift tests with the iOS build.  Each squash merge carries its files by blob hash, so these counts are the bridge source the server runs.  The counts were the same at `4dfc097c`, the revision before PR #2248, where they were first taken.

## Slot 2 Receipt: Authorized Running Server

Recorded 2026-11-27 by Z Code (MM.2.M) on the Linux server that is the primary BotFleet server.  The deploy ran under the owner's standing approval of the gated items of the native rewrite (2026-11-24) and his direction on 2026-11-27 to finish the work; this section records what ran and what was measured, and it authorizes nothing further.  Host names, addresses and paths stay in variable form here; the private inventory holds them.

- **Revision.** The serving checkout reports `53bb9e15c84bc389a6cfd83d876a1ce8b1a16c51` with no local changes, moved there at 8:40 AM and again at 9:45 AM through `deploy/linux-server/update.sh` with the `BF_ROOT` and `BF_CODE` overrides the live layout needs.  That is the revision of the second Slot 1 receipt above.
- **The unit.** `botfleet-companion-bridge.service` is enabled and active: installed on 2026-11-27 at 3:40 AM by the installer's own bridge step, restarted at 8:40 AM and at 9:45 AM on the revision above; it follows the harness, so a harness restart restarts it.  It listens on loopback only; its start lines read `apns sender: key material present` and `listening on 127.0.0.1:8797 -> harness 127.0.0.1:8799 (owners: 1, token: yes)`.
- **The route.** `tailscale serve` publishes the bridge on its own port to the tailnet only, and Funnel is off.  A request with no owner credential is refused with `owner identity required`, from the server and from a Mac alike.
- **Live checks, from a Mac over the tailnet route with the desktop gate credential, 35 of 35 at 9:46 AM on the revision above.** A device was paired through `POST /api/pair` with a six-digit code and revoked after each run; the device list was empty before and after.
  - Before pairing: `GET /api/health` answers 200, and `GET /api/companion/endpoints` answers `serverName: BotFleet Server` with one endpoint, the bridge route over https, kind `hosted`.
  - Pairing: `POST /api/pair` answers 201 with `token`, `device`, `serverName` and `endpoints`; a spent code and a wrong code are each refused with 401.
  - Paired: `/api/bots`, `/api/quotas`, `/api/config` and `/api/update/status` answer 200, and a thread's messages answer 200 with and without a `limit` parameter.
  - The event stream opens with `{"kind":"hello","cursor":…,"resumed":false}`; asked again with `?since=` set to that cursor it answers `resumed: true`; a cursor that is not a cursor reaches the harness, which answers 400; so the parameter crosses as written.
  - Closed on the bridge, as designed: `POST /api/update/check` and `POST /api/update/run` answer 404 `no bridge route`, and so do `GET /api/fleet` and `GET /api/waits`, which exist only on the Mac app's own companion server.
  - The status the shipped app reads as not paired: with no device credential `/api/bots` answers `401` and names the challenge `WWW-Authenticate: Bearer realm="companion-bridge"`; a credential the bridge never issued is answered the same way, and so is a revoked device's.  With no owner credential at all the gate answers `403` before the bridge is asked.

What the phone does with all of this is Slot 3, and it is not claimed here.


## Slot 3: iPhone Build And Physical Device (Not Verified)

Prerequisites, all owner-side:

- A named TestFlight build of the iOS companion (bundle `app.botfleet.ios`).  TestFlight `202611270252` shipped from the hosted run on 2026-11-27 and carries the pairing contract the bridge serves; the build number is recorded at run time, never assumed.
- A way to open a pairing window on the server.  No app opens one today, and a code lives 300 seconds, so for now a seat opens the window at the moment of the run; BF-2713 gives the Mac app that screen, and until it ships the QR half of P1 waits on it.
- A physical iPhone paired with the **server** bridge (not the Mac), with the Mac asleep for the server-first rows.
- For P8 only, a build that carries BF-2714 and a phone paired with the Mac as well as the server. The Mac says its applied placement in its advertisement, and the phone keeps the last one it heard, so the Mac has to have been reached once in `serverFirst`.
- The scoped APNs grant for the Linux sender, by name only: `APNS_KEY_P8`, `APNS_KEY_ID`, and `APNS_TEAM_ID`.  The three names are present where the bridge reads them, and its start line reports `apns sender: key material present`.  Values are never written in this checklist, in Linear, or in chat.

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
