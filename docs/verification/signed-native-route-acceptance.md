# Signed Native Route Acceptance Checklist

Status:  source-only checklist (`Refs BF-2498`).  Nothing here has been run.  No
install, no update, no signing run, no live pair and no owner acceptance is
recorded here, and this document does not authorize any of them.

## What This Checklist Is

BF-2498 asks for two things that are easy to confuse:  an inventory of every
responsibility the Electron main process still carries, and a signed native
build installed as the one copy at `~/Applications/BotFleet.app`, so the
phone's "Open on Mac" opens the native app instead of the shell that is on its
way out.

This document is the acceptance half of that:  what has to be observed, on
which profile, and what each observation does and does not prove.  The
inventory half is the Electron decommission map, which is a separate
document.

The checklist has **two profiles**, and they are not interchangeable:

- **Profile A, Mac-only.**  A fresh native startup with no server configured
  at all, and no BotFleet Node process running.  This is the profile that
  proves the native app stands on its own.
- **Profile B, server-first with the Mac asleep.**  Jay's server-owned
  placement, with the phone talking to the Linux server while the Mac is
  asleep.  This is the profile that proves the phone keeps working when the
  machine that used to answer it is not.

A pass in Profile A is not evidence for Profile B, and a pass in Profile B is
not evidence for Profile A.  A run under one profile is filed under that
profile and never under the other.

## The Candidate And The Baseline

| | Signed native candidate | Verified prior baseline |
| --- | --- | --- |
| Source | `638f3469e` (`638f3469ed8d9a8276feaf210f4e8e38669445f9`) | `afd255fa8` |
| Build number | `202611211946` | none recorded |
| Workflow run | `native-mac-release.yml` run `44975323207` | run `44883556838` |
| Artifact | `botfleet-native-0.1.0-638f3469ed8d9a8276feaf210f4e8e38669445f9`, artifact id `14735666706` | `native-mac-release`, artifact id `14699935187` |
| Artifact lifetime | created Sat, Nov 21, 8:27 PM, expires Fri, Dec 5, 8:27 PM | created Sat, Nov 21, 8:26 AM, expires Fri, Dec 5, 2:26 AM |
| Signing, notarization, stapling | passed | passed |
| Signed asset and appcast verification | passed | **failed** at "Verify the appcast against the actual bytes" |
| Feed publication | none | none |
| Installation | none | none |
| Daily-driver observation | none | none |
| Device receipt | none | none |

The candidate is a **signed package that has never been installed**.  The
prior baseline is **not a verified signed build**:  its signing job passed but
the appcast verification failed, so the artifact that carries it cannot serve
as the "previous build" an installed update starts from.  The
installed-previous-build-update row therefore has **no verified baseline yet**,
and the checklist names that as a gap rather than borrowing the failed
artifact to fill it.

Two limits of the candidate, both recorded here so nobody reads more into it
later:

- The draft release attachment was skipped, so the run produced a verified
  artifact and no published release.
- The pinned workflow still allowed a GitHub-secret fallback for the Developer
  ID and for optional Sentry.  The candidate therefore does **not** establish
  current Infisical-only acceptance.  A future candidate built with the
  store-only path is a separate item and needs its own run.
- The candidate **predates the merged Open-on-Mac action** (BF-2690, PR
  #2189):  the native app in this build answers the phone's "Open on Mac"
  with `501`, because no launch action is installed in it.  The artifact is
  preserved as historical packaging evidence and nothing more;  Profile A's
  Open-on-Mac row is blocked on a **verified Infisical-only signed candidate
  that contains the merged callback**, and both the eventual test and the
  `signed-release` receipt are pinned to that candidate, not to this one.

## The Two Prerequisites

Two things stand before a Profile A run, and neither exists yet.  They are
named here so the wait is for something specific.

**1.  A freshly signed Infisical-only candidate that contains the merged
Open-on-Mac action.**  BF-2690 (#2189) installs the real launch callback, and
the recorded candidate predates that merge:  its app answers `501`, so the
whole A8 to A11 row waits.  The prerequisite is one `native-mac-release.yml`
run whose source contains #2189, built through the store-only path with no
Developer-ID or Sentry secret fallback, passing signing, notarization,
stapling and the appcast verification.  The A8 to A11 rows and the
`signed-release` receipt all pin to that run and to no other.

**2.  The redacted read-only hosted-planner receipts (OPS-1108).**  Both
hosted release planners still take the scoped Infisical read from a
composite fetch whose binding ends at its own step, so the iOS
`plan-build` and `ship` consumers and the Mac `prepare` consumer have no
scoped read of their own, and the pinned workflows keep Developer-ID and
Sentry secret fallbacks.  The prerequisite is the review-only workflow diff
that closes that gap, and with it one receipt per planner run that records,
in redacted form:  the run id and head SHA, which steps consumed the scoped
fetch, the secret NAMES the fetch asked for and never their values, and
that no signing or Sentry fallback ran.  A candidate without those receipts
is not an Infisical-only candidate, whatever its appcast says, and the
`signed-release` receipt refuses to cite one.

Neither prerequisite dispatches a run, mints a key, changes a credential,
publishes a route or tests a phone.  This document names them;  producing
them is the workflow lane's work (OPS-1108) and the owner's dispatch.

## Profile A:  Mac-Only, No Server Configured

Preconditions, all owner-side and none of them implied by this document:

- The candidate above is installed as the one copy at
  `~/Applications/BotFleet.app`, with the bundle id `app.botfleet.macos`.
- The Electron app is out of `~/Applications` and out of Login Items, in the
  rollback archive, and not deleted.
- No server is configured in **Settings → Servers**, and no BotFleet Node
  process is running.
- The native companion listener is on: **Settings → General → Host The
  Companion API From This App**.

| # | Observe | Expected | Where |
| --- | --- | --- | --- |
| A1 | Launch the native app with the harness down | the app starts; it does not require a Node harness | app launch, `~/Library/Logs` or the journal |
| A2 | Optional, separate from A1:  the launch starts the launchd harness when it is down, and clears `~/.botfleet/stopped.marker` | the harness comes up; the marker is gone | `launchctl print gui/$(id -u)/app.botfleet.server`, `~/.botfleet/stopped.marker` |
| A3 | **Settings → Servers** holds no server row | the app is Mac-only and says so | the Settings window |
| A4 | The companion listener is on and the LAN opt-in is off | the listener binds loopback and advertises no LAN route | the listener state line under the toggle |
| A5 | The phone pairs with the Mac over Tailscale | the pairing window opens, the code or QR shows, the phone appears in **Settings → Phone → Paired Phones** | Settings → Phone |
| A6 | A chat turn runs on the Mac with no server configured | the turn runs natively and the transcript updates | the transcript |
| A7 | The phone receives a push while the app is in the background | the alert arrives with the native payload shape | the phone |
| A8 | **Blocked on the future candidate.**  The phone sends **Open on Mac** | the Mac app comes forward | the Mac screen |
| A9 | **Blocked on the future candidate.**  Open on Mac with **Settings → General → Allow iOS Remote Desktop Launch** off | `403`, and the message says the setting is off | the phone's error |
| A10 | **Blocked on the future candidate.**  The phone tries to open the gate itself through `PUT /api/config` | `403` | the phone's request |
| A11 | **Blocked on the future candidate.**  Open on Mac over a non-loopback caller | `403` | the listener's log |
| A12 | Quit the app, then launch it again | the listener is gone after the quit and back after the launch | `launchctl`, Settings → General |
| A13 | Close the last window with **Keep Server Running When Window Closes** on | the app stays in the menubar and the listener stays up | the menubar |
| A14 | Close the last window with that setting off | the listener stops with the window | the menubar |

A8 to A11 are the Open-on-Mac row, and all four are pinned to the future
candidate, not only A8.  The refusal rows are not runnable against the
recorded artifact either:  a build with no launch action answers `501`
before any of the three gates can answer `403`, so running A9 to A11
there produces false failures rather than evidence.  On the future
candidate the route brings the window forward,  and the setting gate is
still the owner's:  a grant that has not been read stays closed.

## Profile B:  Server-First With The Mac Asleep

Preconditions, and they are different from Profile A's:

- The Linux server owns the placement:  `botfleet-server.service` runs the
  harness on loopback, behind the owner gate, published through
  `tailscale serve`.
- The phone is paired with the **server**, not with the Mac, and the server
  is the placement mode's controller.
- The Mac is **asleep**, or logged out.  The Mac's own listener is not
  answering anything.

| # | Observe | Expected | Where |
| --- | --- | --- | --- |
| B1 | The phone lists the server as a computer and pairs with it | the pairing window opens on the server side | the phone, the server's log |
| B2 | A chat turn runs on the server while the Mac is asleep | the turn runs and the transcript updates on the phone | the phone |
| B3 | A job the server owns completes while the Mac is asleep | the phone sees the completion | the phone |
| B4 | The server sends a background alert for that device | the alert arrives, sent by the server | the phone |
| B5 | The phone's foreground stream resumes after a dropout | the stream catches up from its cursor | the phone |
| B6 | The Mac wakes and the app launches | no duplicate delivery:  one device, one sender | the phone, the server's log |

B6 is the one-sender rule, and it is the row that proves the server and the
Mac are not both pushing for the same device.

### What Profile B Cannot Close

Two things stand between this profile and a pass, and neither is a source
change:

- **APNs from the server.**  The Linux sender needs the scoped read-only
  Infisical key grant for `APNS_KEY_P8` and `APNS_KEY_ID` (and the team id
  the sender signs for).  The grant is an owner action, and the key material
  is not in the repository.  Until the grant exists and the vault holds the
  material, the server cannot sign an alert, so B4 cannot be observed.
- **The bridge route.**  The server-side companion bridge is packaged under
  BF-2691 and is default-off:  the unit is written and enabled only under
  `BF_COMPANION_BRIDGE=1`, and the `tailscale serve` route for it is a
  hand-run owner step.  Until that is done, the phone cannot reach the
  server's companion surface at all.

So a Profile B run that never had the Mac asleep proves nothing about
Profile B, and a Profile B run on a server with no APNs grant cannot close
B4 no matter how long it is left running.  Both facts belong in the run's
record, not in a later summary.

## What Each Done-When Item Needs

| BF-2498 Done-when item | Profile | Evidence | State today |
| --- | --- | --- | --- |
| Every inventory row has a named owner | neither | the Electron decommission map | in progress, separate document |
| The iOS companion works with Electron not running | A | A5, A6, A7 | not run |
| Open on Mac opens the native app | A | A8, with A9 to A11 as the refusals | **blocked**:  the whole A8 to A11 row is pinned to a verified Infisical-only signed candidate that contains the merged launch action;  the recorded artifact predates it and answers `501`, so no row of the four is runnable against it |
| One installed native copy at `~/Applications/BotFleet.app` | A | the install itself | not done:  no install is authorized here |
| The companion without Electron | A | A5 to A7 | not run |
| The signed build is the one that is installed | A | the install receipt for the candidate | not done; the recorded artifact expires Fri, Dec 5, 8:27 PM and predates the merged launch action, so the eventual install receipt is pinned to the future verified store-only candidate |
| An installed previous build updates through the native feed | A | the `signed-release` receipt's `installed-previous-build-update` check | blocked:  no verified prior baseline exists |
| The phone keeps working while the Mac is asleep | B | B1 to B6 | not run; blocked on the APNs grant and the bridge route |
| Jay signs off a 7-day soak | A and B | the `daily-driver` receipt and the owner's acceptance | not started; the owner signs it |

## The Receipts This Checklist Feeds

The decommission bundle names the receipts, and this checklist is what fills
four of them:

- `signed-release` — the signing, notarization, stapling, one installed copy,
  the Open on Mac target, the companion without Electron, and the installed
  previous-build update.  Its producer reads a verification record and the
  artifacts it names; the exit codes come out of that record.
- `daily-driver` — the seven-day native daily-driver observation, with the
  iOS session, Open on Mac and the process inventory recorded per segment.
- `control-disposition` — the owner's Decision 1 disposition and the
  implementation that lands with it, tracked under BF-2688.
- `change-plan` — the exact jobs, files and app copies the cutover changes.

The `owner-acceptance` receipt has no producer on purpose:  the collector
refuses to synthesize an owner's assertion.

## Non-Authorizations

This document authorizes nothing.  It does not authorize an install, an
update, a signing run, a rebuild, a deletion, an Electron archival, a route
publication, a grant, a key rotation, or a live pair.  It records what has
already been produced, what is missing, and what a person would have to
observe to close each row.
