# Native Lifecycle Controls

BotFleetMac's Settings › Lifecycle section carries the product half of the Option C split:  the harness status, the Local VM start and stop, the Start Server At Login policy, and Start Server, which starts the installed harness LaunchAgent on request.  The same controls were in BotFleet Control, the Electron menu bar controller documented in [Independent Server Controls](server-controls.md).  The ruling is Decision 1 in `docs/plans/2026-10-29-botfleet-control-after-node.md`.

## What Each Control Does

**Server Status** reads `GET /api/system/control` on the loopback harness. **Start Shared VM** and **Stop Local VMs** post to the harness's own VM routes.  A connection to any address other than loopback is refused before a request is made, because the routes carry no token.

**Start Server At Login** writes the wrapper's own markers, `startup-enabled.marker` or `startup-disabled.marker` with a `startup-session`, and is refused when the installed wrapper predates `BF_CONTROL_STARTUP_POLICY_V1`.

**Start Server** asks launchd for the `app.botfleet.server` job and for nothing else.  The order is the one BotFleet Control used, and each step follows the wrapper's own contract.

1. The installed wrapper must carry `BF_CONTROL_STARTUP_POLICY_V1`, and the LaunchAgent plist must be in `~/Library/LaunchAgents`.  Otherwise nothing is written and launchd is not asked.
2. The deliberate-stop marker is read through a descriptor opened with `O_NOFOLLOW`.  A link, a folder or a file past 64 KB is refused and left in place.
3. The boot session is read, refused unless it is a UUID, and recorded, and the stop marker is cleared.  The startup session file is read through the same `O_NOFOLLOW` handle, with the same one-link and device-and-inode checks as the marker.  A session file that is a link, is hard-linked, is larger than 64 KB, or cannot be read is refused and nothing is started:  a start whose prior bytes cannot be captured could not be undone.  The session is what makes the start work under a do-not-start-at-login policy:  launchd runs the wrapper for a kickstart like any other tick, and the wrapper leaves that policy alone unless the recorded session is this boot.
4. `launchctl enable`, then `bootstrap` only when `launchctl print` says the job is not loaded, then `kickstart`.  A print that launchd refused, that did not finish, or whose reply was cut off at the byte bound is not a not-loaded answer, so it never causes a second bootstrap.
5. The job is watched for eight looks a quarter of a second apart.  A process still behind the label at the last look is the start.  Otherwise the session file and the stop marker are put back with the bytes they had, through the same checked handles.  A marker that cannot be written back is reported as `stopNotRestored` rather than as a restored stop.

The control itself is a button in Settings › Lifecycle and a row in the Fleet menu.  Both gate on those same three facts, and the section probes launchd beside the status read so the offer has its third fact whether or not the harness is there.

Start Server is offered only when three facts agree:  the wrapper can be started through the policy, nothing answered on the harness port, and the job is installed without a live process behind the label.  The third is what keeps a hung server from being offered a start, because it refuses the connection too while launchd still shows its process.  A refused connection is the only read failure that counts as nothing listening.  A timeout or an unreadable reply does not.

## Fixture Verification

Run from a seat lane on a Mac with Xcode:

```sh
cd ios
swift test --filter MacServerStartTests
swift test --filter MacControlStatusTests
swift test --filter MacHonestControlsTests
```

`MacServerStartTests` injects a launchctl that answers from a script and records every request, a pause that records instead of waiting, a boot session, and a home directory made for the test that holds the wrapper, the plist and the data directory.  The tests prove the exact `launchctl` requests and their order, that an already loaded job is not loaded twice, that every refusal leaves the stop marker byte for byte, that an unsafe marker is never cleared, the offer rule for every combination of its three facts, each way the settle window can end, that an unreadable or linked session file refuses the start before launchctl is asked, and that a cut-off `launchctl print` reply is not read as a not-loaded job.  It also answers the status read from a stubbed `URLSession`, and proves a refused connection is told apart from a reply that could not be read, which is what the offer's second fact rests on.

`MacControlStatusTests` injects the harness's answers through a stubbed `URLSession`.  It proves the status decode, a 404 read as an older server, a 403 read as a foreign service, and the startup markers.  `MacHonestControlsTests` proves the Lifecycle section has a screen behind it.

## What The Fixtures Do Not Prove

No test here talks to a real launchd, a real wrapper or a running harness.  They do not show that the installed wrapper on a given Mac honours the policy, that the LaunchAgent's `ProgramArguments` point at it, or that the harness comes up and answers after a start on an installed build.  That is the installed-route check BF-2527 holds, and it is the owner's.  A start also assumes `gui/<uid>` is the domain of the logged-in user, which no fixture states.
